import type { ChatMessage } from '../chatmodel/types';

/**
 * 轻量 token 估算器（Phase 14，依赖克制：不引第三方分词器）。
 *
 * 为什么不直接用字符数 / 4？因为中文等宽字符（CJK）在主流分词器里约 1 字符 = 1 token，
 * 而拉丁字母/数字/标点约 4 字符 = 1 token。用统一 4/字符会把中文成本低估 ~4 倍。
 * 这里用「宽字符按 1、窄字符按 4 估算」的启发式，误差可接受，足够做成本展示与预算告警。
 *
 * 注意：本估算只用于「API 未回报真实用量时」的兜底展示；真实用量以适配器解析的
 * `CompleteResult.usage` 为准（见 chatmodel/*）。压缩预算（CompressOptions.budgetTokens）
 * 由 memory/compressor 的 estimateHistoryTokens 独立估算，二者口径不同属正常。
 */

/** 宽字符（CJK / 假名 / 全角 / 谚文等）Unicode 区间 */
const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x3000, 0x303f], // CJK 符号与标点
  [0x3040, 0x30ff], // 平假名 + 片假名
  [0x3400, 0x4dbf], // CJK 扩展 A
  [0x4e00, 0x9fff], // CJK 基本汉字
  [0xac00, 0xd7a3], // 谚文音节
  [0xf900, 0xfaff], // CJK 兼容汉字
  [0xff00, 0xffef], // 全角字符
];

function isWide(cp: number): boolean {
  for (const [a, b] of WIDE_RANGES) {
    if (cp >= a && cp <= b) return true;
  }
  return false;
}

/** 估算一段纯文本的 token 数：宽字符 1/个，窄字符 4/个（向上取整） */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let wide = 0;
  let narrow = 0;
  for (const ch of text) {
    if (isWide(ch.codePointAt(0) ?? 0)) wide++;
    else narrow++;
  }
  return wide + Math.ceil(narrow / 4);
}

/** 估算一条消息的 token（文本块累加；工具调用以其参数 JSON 计） */
function estimateMessageTokens(m: ChatMessage): number {
  if (typeof m.content === 'string') return estimateTokens(m.content);
  let t = 0;
  for (const b of m.content) {
    t += b.type === 'text' ? estimateTokens(b.text) : estimateTokens(JSON.stringify(b.arguments));
  }
  return t;
}

/**
 * 估算整段对话的 prompt token 数。
 * 每条消息外加约 3 token 的结构开销（role 标记等），与 OpenAI tiktoken 的量级接近。
 */
export function estimateMessagesTokens(messages: ChatMessage[]): number {
  let total = 0;
  for (const m of messages) total += 3 + estimateMessageTokens(m);
  return total;
}
