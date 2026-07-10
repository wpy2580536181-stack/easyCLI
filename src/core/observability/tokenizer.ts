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

/**
 * 可插拔的 token 计数契约（Phase 14 增强：压缩预算用真实/校准计数，而非粗糙字符估算）。
 * - count(text)：返回文本 token 数。
 * - calibrate?：可选，用真实用量反校准内部系数（仅自校准实现提供）。
 */
export interface TokenCounter {
  count(text: string): number;
  /** 用「真实 token 数 / 本计数器估算数」校准内部系数（指数移动平均），使后续预算更接近真实 */
  calibrate?(realTokens: number, estimatedTokens: number): void;
}

/**
 * 自校准计数器：以 CJK 感知启发式为底，用每轮模型回报的真实 usage 学一个系数。
 * 零依赖、跨轮共享同一实例即可越跑越准；真实 BPE 不可用时的默认实现。
 */
export class CalibratedCounter implements TokenCounter {
  private calibration = 1;

  count(text: string): number {
    return Math.max(1, Math.round(estimateTokens(text) * this.calibration));
  }

  calibrate(real: number, estimated: number): void {
    if (estimated <= 0) return;
    const ratio = real / estimated;
    // 指数移动平均（0.8/0.2），平滑单次噪声、又能随模型切换缓慢适配
    this.calibration = this.calibration * 0.8 + ratio * 0.2;
  }
}

/**
 * 真实 BPE 计数器：用 tiktoken 的 cl100k_base 精确编码（与 GPT 类模型一致）。
 * 动态加载——未安装 tiktoken 时 create() 会 reject，由工厂回退到自校准实现，不强制第三方依赖。
 */
export class TiktokenCounter implements TokenCounter {
  private constructor(private readonly encode: (t: string) => number[]) {}

  static async create(): Promise<TiktokenCounter> {
    try {
      // 用变量拼模块名，绕过 tsc 对字面量模块的解析检查；运行时未装则抛错被上层捕获
      const spec = 'tiktoken';
      const mod: unknown = await import(spec);
      const enc = await (mod as { getEncoding: (n: string) => Promise<{ encode: (t: string) => number[] }> }).getEncoding(
        'cl100k_base',
      );
      return new TiktokenCounter((t: string) => enc.encode(t));
    } catch {
      throw new Error('tiktoken 未安装：npm i tiktoken 后即可用真实 BPE 计数');
    }
  }

  count(text: string): number {
    return this.encode(text).length;
  }
}

let defaultCounter: TokenCounter | null = null;
/** 模块级默认计数器单例（供未显式注入时的独立调用，如单测） */
export function createDefaultCounter(): TokenCounter {
  if (!defaultCounter) defaultCounter = new CalibratedCounter();
  return defaultCounter;
}

/**
 * 创建计数器：
 * - 'tiktoken'：优先真实 BPE，失败（未安装）静默回退自校准；
 * - 'auto'（默认）：零依赖的自校准实现。
 * 真实 BPE 与自校准都让压缩预算更接近「模型实际收到的 token 数」。
 */
export async function createCounter(mode: 'auto' | 'tiktoken' = 'auto'): Promise<TokenCounter> {
  if (mode === 'tiktoken') {
    try {
      return await TiktokenCounter.create();
    } catch {
      return new CalibratedCounter();
    }
  }
  return new CalibratedCounter();
}
