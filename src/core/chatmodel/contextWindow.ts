// 各 provider / 模型的默认上下文窗口（token 数）。
//
// 用途：把压缩预算从「绝对 8000」改为「窗口相对」（见 memory/compressor）。
// 参考 Claude Code / mini-claude：预算 = 窗口 - 最大输出 - 缓冲(~20K)，
// 触发点在 ~85% 利用率，而非固定的小数字。
// 这里只作保守估计；用户可用 --context-window 精确覆盖。

/** provider 级默认窗口（token） */
const PROVIDER_DEFAULT_WINDOW: Readonly<Record<string, number>> = {
  anthropic: 200_000,
  openai: 128_000,
  ollama: 32_000,
};

/** 已知模型的精确窗口覆盖（命中则优先于 provider 默认）。
 * 例如 deepseek-chat 实际仅 64K，而 provider=openai 的默认是 128K，需单独校正。 */
const MODEL_WINDOW: Readonly<Record<string, number>> = {
  'deepseek-chat': 64_000,
  'deepseek-reasoner': 64_000,
};

/**
 * 推导一个保守的上下文窗口大小。
 * 命中已知模型 → 用精确值；否则用 provider 默认；都无则回退 128K。
 */
export function defaultContextWindow(provider: string, model: string): number {
  if (MODEL_WINDOW[model]) return MODEL_WINDOW[model]!;
  return PROVIDER_DEFAULT_WINDOW[provider] ?? 128_000;
}

/**
 * 由窗口推导压缩预算（token）。
 * 公式：budget = 窗口 - 最大单次输出 - 缓冲(20K)，并设 8000 硬下限，
 * 避免窗口过小（本地模型）时把历史压到几乎没空间。
 */
export function resolveCompressBudget(
  contextWindow: number,
  maxOutputTokens = 4096,
): number {
  const effective = contextWindow - Math.max(maxOutputTokens, 16_384) - 20_000;
  return Math.max(8000, effective);
}
