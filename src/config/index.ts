// 配置加载与合并。
// 优先级：CLI 参数 > 环境变量 > 默认值。
// 这样 Phase 1 跑 MVP 只需 export AGENTCLI_API_KEY=xxx 即可。

export interface LlmConfig {
  baseURL: string;
  apiKey: string;
  model: string;
}

export interface AppConfig {
  provider: string;
  llm: LlmConfig;
}

export interface ConfigOverrides {
  provider?: string;
  baseURL?: string;
  apiKey?: string;
  model?: string;
}

/**
 * 按候选顺序取第一个"非空"值；全空则回退默认值。
 * 空字符串视为"未设置"，从而正常回退（避免 env 被显式置空时卡在 ''）。
 */
function firstNonEmpty(def: string, ...cands: (string | undefined)[]): string {
  for (const c of cands) {
    if (c !== undefined && c !== '') return c;
  }
  return def;
}

export function loadConfig(overrides: ConfigOverrides = {}): AppConfig {
  const provider = firstNonEmpty(
    'openai',
    overrides.provider,
    process.env.AGENTCLI_PROVIDER,
  );
  const baseURL = firstNonEmpty(
    'https://api.deepseek.com/v1',
    overrides.baseURL,
    process.env.AGENTCLI_BASE_URL,
  );
  const apiKey = firstNonEmpty(
    '',
    overrides.apiKey,
    process.env.AGENTCLI_API_KEY,
    process.env.OPENAI_API_KEY,
  );
  const model = firstNonEmpty(
    'deepseek-chat',
    overrides.model,
    process.env.AGENTCLI_MODEL,
  );

  return { provider, llm: { baseURL, apiKey, model } };
}
