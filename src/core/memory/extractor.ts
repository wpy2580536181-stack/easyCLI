// Phase 20 · 功能①：自动提取（extractMemories）。
//
// 动机（对标 mini-claude 第 8 章 / Learn Claude Code s09）：此前记忆「只有显式 remember
// 才写入」，质量取决于模型「想不想记」。本课精髓是「记忆从普通对话里被动浮现」——
// 每轮结束自动把对话里的稳定偏好/约束/项目事实提取出来写入记忆库，无需用户说「记住这个」。
//
// 设计要点：
// - 挂载点：REPL 回合结束处，fire-and-forget（void + .catch），绝不阻塞主流程、绝不冒泡。
// - 多道门控收敛成本（对齐教程）：本轮已显式 remember 则跳过 / 最近 user 文本过短跳过 /
//   节流（默认关闭）/ 总开关。
// - 二次去重：模型返回后，先与现有记忆清单比对，避免重复写入。
// - 失败静默：解析失败/模型异常都不影响对话。

import type { ChatMessage, ChatModel } from '../chatmodel/types';
import type { MemoryStore } from './store';

/** 模型应返回的单个记忆结构 */
export interface ExtractedMemory {
  name: string;
  type: string;
  description: string;
  body: string;
}

export interface ExtractOptions {
  model: ChatModel;
  store: MemoryStore;
  /** 取最近 N 条消息作为提取素材，默认 10 */
  maxRecentMessages?: number;
  /** 对话素材截断上限（字符），默认 4000 */
  dialogueCharCap?: number;
  /** 最近一条 user 文本最短长度门控（字符），低于则跳过，默认 8 */
  minUserChars?: number;
  /** 距上次提取的最小间隔（毫秒），默认 0 = 不节流 */
  throttleMs?: number;
  /**
   * 节流状态持有对象（可变）。不传则使用进程级单例，跨调用共享「上次提取时间」；
   * 传一个新鲜对象即可在测试/独立会话中隔离节流计时。
   */
  throttleState?: { last: number };
}

/** 进程级默认节流状态（REPL 单进程内跨轮共享，避免高频轮次每轮都提） */
const DEFAULT_THROTTLE: { last: number } = { last: 0 };

const ALLOWED_TYPES = new Set(['user', 'feedback', 'project', 'reference']);

function textOf(m: ChatMessage): string {
  if (typeof m.content === 'string') return m.content;
  return m.content
    .filter((b) => b.type === 'text')
    .map((b) => ('text' in b ? b.text : ''))
    .join('');
}

/** 取最近 N 条 user/assistant 对话的纯文本拼接待提取素材 */
function formatRecent(history: ChatMessage[], max: number): string {
  const lines: string[] = [];
  for (const m of history.slice(-max)) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    const t = textOf(m).trim();
    if (t) lines.push(`${m.role === 'user' ? '用户' : '助手'}：${t}`);
  }
  return lines.join('\n');
}

/** 最近一条 user 消息的纯文本长度（门控用） */
function lastUserTextLen(history: ChatMessage[]): number {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]!.role === 'user') return textOf(history[i]!).trim().length;
  }
  return 0;
}

/** 从模型输出里尽可能稳健地抽出 JSON 数组（容忍 markdown 代码围栏与多余文字） */
function safeParseJsonArray(text: string): unknown[] {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1]!.trim();
  const start = t.indexOf('[');
  const end = t.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return [];
  try {
    const v = JSON.parse(t.slice(start, end + 1));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** 归一化用于去重比对（小写、去空白与标点） */
function normalize(s: string): string {
  return s.toLowerCase().replace(/[\s\p{P}]/gu, '');
}

/**
 * 从本轮对话里被动提取稳定记忆，写入记忆库（source='auto'）。
 * 返回成功写入的条数（0 表示跳过/无新内容/失败）。
 */
export async function extractMemories(history: ChatMessage[], opts: ExtractOptions): Promise<number> {
  const max = opts.maxRecentMessages ?? 10;
  const cap = opts.dialogueCharCap ?? 4000;
  const minUser = opts.minUserChars ?? 8;
  const throttle = opts.throttleMs ?? 0;
  const throttleState = opts.throttleState ?? DEFAULT_THROTTLE;

  // 门控②：最近 user 文本过短（寒暄）无价值
  if (lastUserTextLen(history) < minUser) return 0;
  // 门控③：节流（默认关闭）
  const now = Date.now();
  if (throttle > 0 && now - throttleState.last < throttle) return 0;

  const recent = formatRecent(history, max).slice(0, cap);
  if (recent.trim().length === 0) return 0;

  const existing = opts.store.listAll(200);
  const existingNorm = new Set(
    existing.flatMap((m) => [normalize(m.name ?? ''), normalize(m.description ?? '')]).filter(Boolean),
  );

  const catalog =
    existing.filter((m) => m.name || m.description).length > 0
      ? existing.map((m) => `- ${m.name || '(无名)'}: ${m.description || ''}`).join('\n')
      : '（暂无已有记忆）';

  const prompt =
    '你是记忆提取器。从下面的对话中提取「用户偏好 / 约束 / 项目事实」等跨会话仍有用、' +
    '且无法从项目状态推导的信息。\n' +
    '只返回 JSON 数组，元素形如 {"name","type","description","body"}，' +
    'type 只能是 user/feedback/project/reference 之一。\n' +
    '若没有新信息、或已被「已有记忆」覆盖，返回 []。不要输出任何解释文字。\n\n' +
    `已有记忆：\n${catalog}\n\n对话：\n${recent}`;

  let content: string;
  try {
    const r = await opts.model.complete({ messages: [{ role: 'user', content: prompt }] });
    content = r.content ?? '';
  } catch {
    return 0; // 模型异常：静默跳过，不影响主对话
  }

  const items = safeParseJsonArray(content) as Partial<ExtractedMemory>[];
  if (items.length === 0) return 0;

  let n = 0;
  for (const it of items) {
    const body = typeof it?.body === 'string' ? it.body.trim() : '';
    const name = typeof it?.name === 'string' ? it.name.trim() : '';
    if (!body) continue;
    const norm = normalize(body);
    // 二次去重：body/name/description 任一与现有记忆归一化相同则跳过
    if (norm && existingNorm.has(norm)) continue;
    if (name && existingNorm.has(normalize(name))) continue;
    const type =
      typeof it?.type === 'string' && ALLOWED_TYPES.has(it.type) ? it.type : 'user';
    opts.store.remember(body, 'auto', {
      name: name || body.slice(0, 24),
      description: typeof it?.description === 'string' ? it.description.trim() : body.slice(0, 60),
      type,
    });
    if (norm) existingNorm.add(norm);
    n++;
  }

  if (n > 0) throttleState.last = now;
  return n;
}
