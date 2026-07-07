/**
 * 模型定价表与成本计算（Phase 14）。
 *
 * 价格单位为 **USD / 1K tokens**（输入与输出分开计，输出通常更贵）。
 * 数据为依据各厂商公开定价整理的近似值（截至 2025 年，实际以官网为准），
 * 仅用于本地成本估算展示，不影响任何业务逻辑。
 *
 * 匹配策略：模型 id 形如 `provider:modelName`（如 `openai:deepseek-chat`、
 * `anthropic:claude-3-5-sonnet`），我们取 `:` 之后的模型名做**子串匹配**
 * （不区分大小写），命中即用对应价格；未命中回退到 DEFAULT_PRICE。
 */

export interface ModelPrice {
  /** 每 1K input token 的美元价格 */
  input: number;
  /** 每 1K output token 的美元价格 */
  output: number;
}

/** 未知模型的兜底价格（取一个常见中档价位，避免显示 $0 误导） */
export const DEFAULT_PRICE: ModelPrice = { input: 0.001, output: 0.002 };

/** 已知模型价格表（按模型名子串匹配，越靠前越优先） */
const PRICING: ReadonlyArray<{ match: string; price: ModelPrice }> = [
  // —— OpenAI ——
  { match: 'gpt-4o-mini', price: { input: 0.00015, output: 0.0006 } },
  { match: 'gpt-4o', price: { input: 0.0025, output: 0.01 } },
  { match: 'gpt-4-turbo', price: { input: 0.01, output: 0.03 } },
  { match: 'gpt-3.5-turbo', price: { input: 0.0005, output: 0.0015 } },
  // —— Anthropic（Claude）——
  { match: 'claude-3-5-sonnet', price: { input: 0.003, output: 0.015 } },
  { match: 'claude-3-5-haiku', price: { input: 0.0008, output: 0.004 } },
  { match: 'claude-3-opus', price: { input: 0.015, output: 0.075 } },
  { match: 'claude-3-sonnet', price: { input: 0.003, output: 0.015 } },
  { match: 'claude-3-haiku', price: { input: 0.00025, output: 0.00125 } },
  // —— DeepSeek ——
  { match: 'deepseek-reasoner', price: { input: 0.00055, output: 0.00219 } },
  { match: 'deepseek-chat', price: { input: 0.00027, output: 0.0011 } },
  { match: 'deepseek-coder', price: { input: 0.00014, output: 0.00028 } },
  // —— 智谱 GLM ——
  { match: 'glm-4-plus', price: { input: 0.0001, output: 0.0001 } },
  { match: 'glm-4-air', price: { input: 0.0001, output: 0.0001 } },
  { match: 'glm-4-flash', price: { input: 0.00001, output: 0.00001 } },
  { match: 'glm-4', price: { input: 0.0001, output: 0.0001 } },
  // —— 阿里通义 Qwen ——
  { match: 'qwen-max', price: { input: 0.0004, output: 0.0012 } },
  { match: 'qwen-plus', price: { input: 0.0002, output: 0.0006 } },
  { match: 'qwen-turbo', price: { input: 0.00005, output: 0.0002 } },
  // —— Moonshot（Kimi）——
  { match: 'moonshot', price: { input: 0.00012, output: 0.00012 } },
  // —— 本地模型（Ollama 等，免费）——
  { match: 'ollama', price: { input: 0, output: 0 } },
];

/** 把 `provider:modelName` 规整成模型名（无 `:` 则原样返回） */
export function normalizeModelId(modelId: string): string {
  const i = modelId.indexOf(':');
  return i >= 0 ? modelId.slice(i + 1) : modelId;
}

/** 查价：模型名子串匹配，未命中回退 DEFAULT_PRICE */
export function lookupPrice(modelId: string): ModelPrice {
  const name = normalizeModelId(modelId).toLowerCase();
  for (const { match, price } of PRICING) {
    if (match === 'ollama') {
      // ollama 是 provider 前缀，需整体匹配，单独处理
      if (modelId.toLowerCase().startsWith('ollama')) return price;
      continue;
    }
    if (name.includes(match)) return price;
  }
  return DEFAULT_PRICE;
}

/** 计算一次调用的成本（USD） */
export function costFor(
  modelId: string,
  promptTokens: number,
  completionTokens: number,
): number {
  const p = lookupPrice(modelId);
  return (promptTokens / 1000) * p.input + (completionTokens / 1000) * p.output;
}

/** 把 USD 格式化为带千分位的美元串（保留 6 位小数，避免极小数值显示 0） */
export function formatUSD(usd: number): string {
  if (usd === 0) return '$0';
  if (usd < 0.000001) return '<$0.000001';
  return `$${usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`;
}
