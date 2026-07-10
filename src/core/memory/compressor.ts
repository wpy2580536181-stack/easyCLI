import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChatMessage, ChatModel } from '../chatmodel/types';
import { compressorSystemPrompt } from '../prompts';
import { type TokenCounter, createDefaultCounter } from '../observability/tokenizer';

/**
 * 上下文压缩器（Phase 4，决策 7 + §8.1 的渐进压缩；Phase 19 对照 Claude Code /
 * mini-claude 重写为「窗口相对预算 + 大结果落盘 + 缓存友好摘要 + 应急兜底」）。
 *
 * 设计原则：
 * 1. **独立于长期记忆**——压缩只决定「发给模型的上下文视图」，不改写长期记忆库。
 * 2. **渐进式、便宜先跑**——每级都可能释放足够空间，不必走到最后一级：
 *    第0.5级 落盘（超大 tool 结果写磁盘，留预览标记）→
 *    第1级   裁剪（截旧工具/助手输出，最近 N 条完整保留）→
 *    第2级   去重（相邻相同工具结果）→
 *    第3级   折叠（中间工具结果换占位，保留 tool_call 配对）→
 *    第4级   摘要（模型把中间轮压成一条；仅在 turn boundary，且用缓存保证确定性）
 * 3. **不破坏 tool_call ↔ tool_result 配对**——折叠/摘要都以「整轮」为原子单位操作，
 *    保证 OpenAI 协议要求的配对合法性；system 消息永远原样保留。
 * 4. 压缩产生的是「发给模型的副本」，规范 history 不被改写（避免重复摘要、保证工具结果回注正确）。
 * 5. **护住前缀缓存**——L4 摘要只在 turn boundary 触发，且按 middle 内容哈希缓存，
 *    使压缩副本确定性、不每轮乱动缓存前缀（否则会把 P0 的缓存命中率打回 0%）。
 */

/** 摘要器：把一段对话文本压成简短摘要（由模型实现，注入到执行器） */
export type Summarizer = (text: string, signal?: AbortSignal) => Promise<string>;

export interface CompressOptions {
  /** 总 token 预算（目标上限）；history 估算超过即触发压缩。由窗口推导（见 chatmodel/contextWindow） */
  budgetTokens: number;
  /** 保留最近 N 个「轮」（以 user 消息为锚点）不被摘要/折叠 */
  keepRecentTurns: number;
  /** 单条工具/助手输出裁剪上限（第 1 级，字符） */
  maxToolOutputChars: number;
  /** 第 4 级 摘要回调；不提供则只用结构化折叠（第 3 级） */
  summarizer?: Summarizer;
  /** 可插拔 token 计数器：压缩预算用真实/校准计数（缺省回退 CJK 感知自校准） */
  counter?: TokenCounter;

  // —— Phase 19 新增 ——
  /** 大结果落盘目录；提供时，超 persistThresholdChars 的 tool 结果写盘并留预览标记 */
  persistDir?: string;
  /** 落盘阈值（字符）；默认 30000 */
  persistThresholdChars?: number;
  /** 落盘后上下文内保留的预览字符数；默认 2000 */
  previewChars?: number;
  /** 第 1 级裁剪时，保留最近 N 条 tool 结果完整（不裁）；默认 3（参考 Claude Code KEEP_RECENT_TOOL_RESULTS） */
  keepRecentToolResults?: number;
  /** 是否处于 turn boundary：仅此时允许 L4 摘要（工具循环中段不摘要，避免破缓存前缀） */
  atTurnBoundary?: boolean;
  /** 摘要缓存：以 middle 内容哈希为键，使摘要确定性、跨轮复用（護缓存） */
  summaryCache?: Map<string, string>;
  /** 摘要连续失败熔断上限；默认 3 次后不再摘要、只折叠 */
  maxSummaryFailures?: number;
  /** 摘要连续失败计数（可变，跨轮共享同一引用）；达上限后熔断 */
  summaryFailures?: { n: number };
  /** 摘要前写 transcript 落盘目录；提供时把中间历史完整写盘（细节可恢复） */
  transcriptDir?: string;
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

export function estimateHistoryTokens(history: ChatMessage[], counter?: TokenCounter): number {
  const c = counter ?? createDefaultCounter();
  return history.reduce((s, m) => s + c.count(messageText(m)), 0);
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

/** 取消息数组中「最后 N 条 role==='tool'」的消息引用集合（用于第 1 级选择性保留） */
function recentToolMessages(msgs: ChatMessage[], n: number): Set<ChatMessage> {
  const set = new Set<ChatMessage>();
  if (n <= 0) return set;
  for (let i = msgs.length - 1; i >= 0 && set.size < n; i--) {
    if (msgs[i]!.role === 'tool') set.add(msgs[i]!);
  }
  return set;
}

/** FNV-1a 32 位哈希 → 16 进制串（确定性，用于摘要缓存键） */
export function simpleHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

/** 第 0.5 级：超大 tool 结果落盘，上下文内只留预览标记（模型可 re-read 取回） */
function persistLargeResults(msgs: ChatMessage[], opts: CompressOptions): ChatMessage[] {
  const dir = opts.persistDir;
  if (!dir) return msgs;
  const thr = opts.persistThresholdChars ?? 30_000;
  const preview = opts.previewChars ?? 2000;
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    return msgs;
  }
  return msgs.map((m) => {
    if (m.protected) return m;
    if (m.role === 'tool' && typeof m.content === 'string' && m.content.length > thr) {
      try {
        const file = join(dir, `${Date.now()}-${m.name ?? 'tool'}.txt`);
        writeFileSync(file, m.content);
        const head = m.content.slice(0, preview);
        return {
          ...m,
          content: `<persisted-output path="${file}">\n${head}\n…[已落盘，原始 ${m.content.length} 字符，可用 read 读回]</persisted-output>`,
        };
      } catch {
        return m;
      }
    }
    return m;
  });
}

/** 第 1 级：裁剪超长工具/助手输出（有损但便宜）。
 *  keepFull 中的消息（最近 N 条 tool 结果）豁免裁剪，保留完整。 */
function trimMessage(m: ChatMessage, cap: number, keepFull: boolean): ChatMessage {
  if (keepFull) return m;
  if (m.protected) return m; // 受保护消息豁免裁剪
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
      !prev.protected &&
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

/** 摘要前把完整中间历史写盘（细节可恢复；参考 Claude Code 先存 transcript） */
function writeTranscript(dir: string, text: string): void {
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `transcript-${Date.now()}.jsonl`), text);
  } catch {
    // 落盘失败不阻断主流程
  }
}

/**
 * 逐级压缩，返回「发给模型的副本」。
 * 任何一级之后若已低于预算即提前返回，不必走到最后一级。
 */
export async function compressHistory(
  history: ChatMessage[],
  opts: CompressOptions,
): Promise<ChatMessage[]> {
  const counter = opts.counter ?? createDefaultCounter();
  const system = history.filter((m) => m.role === 'system');
  const rest = history.filter((m) => m.role !== 'system');

  // 第 0.5 级：超大 tool 结果落盘（在裁剪之前，确保完整内容先落盘）
  let working = opts.persistDir ? persistLargeResults(rest, opts) : rest;

  // 第 1 级：裁剪（最近 keepRecentToolResults 条 tool 结果保留完整，只裁旧的）
  const keepFull = recentToolMessages(working, opts.keepRecentToolResults ?? 3);
  working = working.map((m) => trimMessage(m, opts.maxToolOutputChars, keepFull.has(m)));
  if (estimateHistoryTokens(working, counter) <= opts.budgetTokens) return [...system, ...working];

  // 第 2 级：去重
  working = dedupeToolResults(working);
  if (estimateHistoryTokens(working, counter) <= opts.budgetTokens) return [...system, ...working];

  // 超预算 → 处理「中间」部分，保留最近 keepRecentTurns 轮 + protected 轮
  const turns = splitIntoTurns(working);
  const recent = turns.slice(-opts.keepRecentTurns);
  const middle = turns.slice(0, -opts.keepRecentTurns);
  const pinnedTurns = middle.filter((t) => t.some((m) => m.protected === true));
  const workableMiddle = middle.filter((t) => !t.some((m) => m.protected === true));

  // 第 3 级：折叠中间的工具结果
  const foldedMiddle = workableMiddle.map((t) => t.map(foldToolResult));
  const afterFold = [...pinnedTurns.flat(), ...foldedMiddle.flat(), ...recent.flat()];
  if (estimateHistoryTokens(afterFold, counter) <= opts.budgetTokens)
    return [...system, ...afterFold];

  // 第 4 级：仅在 turn boundary 用摘要器把中间轮压成一条摘要；
  // 按 middle 哈希缓存，使摘要确定性、不每轮重写缓存前缀。失败/熔断则回退折叠。
  if (opts.summarizer && opts.atTurnBoundary !== false) {
    const middleText = workableMiddle.flat().map((m) => `${m.role}: ${messageText(m)}`).join('\n');
    const hash = simpleHash(middleText);
    let summary = opts.summaryCache?.get(hash) ?? '';
    const fused = (opts.summaryFailures?.n ?? 0) >= (opts.maxSummaryFailures ?? 3);
    if (!summary && !fused) {
      if (opts.transcriptDir) writeTranscript(opts.transcriptDir, middleText);
      try {
        summary = await opts.summarizer(middleText);
        opts.summaryCache?.set(hash, summary);
      } catch {
        if (opts.summaryFailures) opts.summaryFailures.n++;
        summary = '';
      }
    }
    if (summary) {
      const summaryMsg: ChatMessage = {
        role: 'system',
        content: `[历史摘要]\n${summary}`,
      };
      return [...system, ...pinnedTurns.flat(), summaryMsg, ...recent.flat()];
    }
  }

  // 无摘要器 / 非 boundary / 熔断：激进折叠（含助手长文本）
  const aggressive = workableMiddle.map((t) => t.map((m) => aggressiveFold(m, opts.maxToolOutputChars)));
  return [...system, ...pinnedTurns.flat(), ...aggressive.flat(), ...recent.flat()];
}

/**
 * 应急压缩（reactive compact）：API 报 prompt_too_long(413) 时调用。
 * 纯函数、不调模型：保留 system + 最近 keepRecentTurns 轮 + protected 轮，
 * 其余中间轮激进折叠（含助手长文本）。不追求降到预算内，只是尽量腾出空间后重试一次。
 */
export function reactiveCompact(history: ChatMessage[], opts: CompressOptions): ChatMessage[] {
  const system = history.filter((m) => m.role === 'system');
  const rest = history.filter((m) => m.role !== 'system');
  const turns = splitIntoTurns(rest);
  const keep = Math.min(turns.length, opts.keepRecentTurns);
  const recent = turns.slice(-keep);
  const older = turns.slice(0, -keep);
  const foldedOlder = older.map((t) => t.map((m) => aggressiveFold(m, opts.maxToolOutputChars)));
  return [...system, ...foldedOlder.flat(), ...recent.flat()];
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
