import type { ChatMessage, ChatModel } from '../chatmodel/types';
import { compressorSystemPrompt } from '../prompts';

/**
 * 上下文压缩器（Phase 4，决策 7 + §8.1 的 4 级渐进压缩）。
 *
 * 设计原则：
 * 1. **独立于长期记忆**——压缩只决定「发给模型的上下文视图」，不改写长期记忆库。
 * 2. **渐进式**——每级都可能释放足够空间，不必走到最后一级：
 *    第1级 裁剪（截旧工具/助手输出）→ 第2级 去重（相邻相同工具结果）→
 *    第3级 折叠（中间工具结果替换为占位，保留 tool_call 配对）→ 第4级 摘要（模型把中间轮压缩成一条）。
 * 3. **不破坏 tool_call ↔ tool_result 配对**——折叠/摘要都以「整轮」为原子单位操作，
 *    保证 OpenAI 协议要求的配对合法性；system 消息永远原样保留。
 * 4. 压缩产生的是「发给模型的副本」，规范 history 不被改写（避免重复摘要、保证工具结果回注正确）。
 */

/** 摘要器：把一段对话文本压成简短摘要（由模型实现，注入到执行器） */
export type Summarizer = (text: string, signal?: AbortSignal) => Promise<string>;

export interface CompressOptions {
  /** 总 token 预算；history 估算超过即触发压缩 */
  budgetTokens: number;
  /** 保留最近 N 个「轮」（以 user 消息为锚点）不被摘要/折叠 */
  keepRecentTurns: number;
  /** 单条工具/助手输出裁剪上限（第 1 级） */
  maxToolOutputChars: number;
  /** 第 4 级 摘要回调；不提供则只用结构化折叠（第 3 级） */
  summarizer?: Summarizer;
}

/** 粗略 token 估算：英文约 4 字符/token，中文约 1.5；取 4 作保守上界 */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/** 把一条消息转成可估算/可摘要的纯文本 */
export function messageText(m: ChatMessage): string {
  if (typeof m.content === 'string') return m.content;
  return m.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
}

export function estimateHistoryTokens(history: ChatMessage[]): number {
  return history.reduce((s, m) => s + estimateTokens(messageText(m)), 0);
}

/** 以 user 消息为锚点，把消息流切成「轮」（user + 其后的 assistant/tool 结果） */
function splitIntoTurns(msgs: ChatMessage[]): ChatMessage[][] {
  const turns: ChatMessage[][] = [];
  let cur: ChatMessage[] = [];
  for (const m of msgs) {
    if (m.role === 'user' && cur.length) {
      turns.push(cur);
      cur = [];
    }
    cur.push(m);
  }
  if (cur.length) turns.push(cur);
  return turns;
}

/** 第 1 级：裁剪超长工具/助手输出（有损但便宜） */
function trimMessage(m: ChatMessage, cap: number): ChatMessage {
  if ((m.role === 'tool' || m.role === 'assistant') && typeof m.content === 'string') {
    if (m.content.length > cap) {
      return { ...m, content: m.content.slice(0, cap) + `\n…[已裁剪 ${m.content.length - cap} 字符]` };
    }
  }
  return m;
}

/** 第 2 级：跳过与上一工具结果完全相同的重复项 */
function dedupeToolResults(msgs: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of msgs) {
    const prev = out[out.length - 1];
    if (
      m.role === 'tool' &&
      prev &&
      prev.role === 'tool' &&
      messageText(prev) === messageText(m)
    ) {
      continue;
    }
    out.push(m);
  }
  return out;
}

/** 第 3 级：把工具结果折叠成占位（保留 tool_call_id，配对合法性不变） */
function foldToolResult(m: ChatMessage): ChatMessage {
  if (m.role !== 'tool') return m;
  const len = messageText(m).length;
  return { ...m, content: `[已折叠工具结果: 原 ${len} 字符，可展开]` };
}

/** 兜底：连助手长文本也折叠 */
function aggressiveFold(m: ChatMessage, cap: number): ChatMessage {
  if (m.role === 'tool') return foldToolResult(m);
  if (m.role === 'assistant' && typeof m.content === 'string' && m.content.length > cap) {
    return { ...m, content: `[已折叠助手回复: 原 ${m.content.length} 字符]` };
  }
  return m;
}

/**
 * 逐级压缩，返回「发给模型的副本」。
 * 任何一级之后若已低于预算即提前返回，不必走到最后一级。
 */
export async function compressHistory(
  history: ChatMessage[],
  opts: CompressOptions,
): Promise<ChatMessage[]> {
  const system = history.filter((m) => m.role === 'system');
  const rest = history.filter((m) => m.role !== 'system');

  // 第 1 级：裁剪
  let working = rest.map((m) => trimMessage(m, opts.maxToolOutputChars));
  if (estimateHistoryTokens(working) <= opts.budgetTokens) return [...system, ...working];

  // 第 2 级：去重
  working = dedupeToolResults(working);
  if (estimateHistoryTokens(working) <= opts.budgetTokens) return [...system, ...working];

  // 超预算 → 处理「中间」部分，保留最近 keepRecentTurns 轮
  const turns = splitIntoTurns(working);
  const recent = turns.slice(-opts.keepRecentTurns);
  const middle = turns.slice(0, -opts.keepRecentTurns);

  // 第 3 级：折叠中间的工具结果
  const foldedMiddle = middle.map((t) => t.map(foldToolResult));
  const afterFold = [...foldedMiddle.flat(), ...recent.flat()];
  if (estimateHistoryTokens(afterFold) <= opts.budgetTokens) return [...system, ...afterFold];

  // 第 4 级：用摘要器把中间轮压成一条摘要（失败则回退折叠）
  if (opts.summarizer) {
    const middleText = middle.flat().map((m) => `${m.role}: ${messageText(m)}`).join('\n');
    let summary = '';
    try {
      summary = await opts.summarizer(middleText);
    } catch {
      summary = '';
    }
    const summaryMsg: ChatMessage = {
      role: 'system',
      content: summary ? `[历史摘要]\n${summary}` : '[历史摘要] (摘要生成失败，已折叠)',
    };
    return [...system, summaryMsg, ...recent.flat()];
  }

  // 无摘要器兜底：激进折叠（含助手长文本）
  const aggressive = middle.map((t) => t.map((m) => aggressiveFold(m, opts.maxToolOutputChars)));
  return [...system, ...aggressive.flat(), ...recent.flat()];
}

/** 默认摘要器：用模型把一段对话文本压成中文摘要（供手动 /compact 命令使用） */
export function createDefaultSummarizer(model: ChatModel): Summarizer {
  return async (text: string) => {
    const r = await model.complete({
      messages: [
        { role: 'system', content: compressorSystemPrompt() },
        { role: 'user', content: text },
      ],
    });
    return r.content ?? '';
  };
}
