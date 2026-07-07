// 配置加载与合并。
// 优先级：CLI 参数 > 环境变量 > 默认值。
// 这样 Phase 1 跑 MVP 只需 export AGENTCLI_API_KEY=xxx 即可。

import type { McpServerSpec } from '../core/mcp/client';

export interface LlmConfig {
  baseURL: string;
  apiKey: string;
  model: string;
}

export interface AppConfig {
  provider: string;
  llm: LlmConfig;
  /** Phase 5：要连接的 MCP Server 列表（stdio），可为空 */
  mcpServers: McpServerSpec[];
  /** Phase 6：RAG 语料源（文件/目录，逗号分隔），可为空 */
  ragPath: string;
}

export interface ConfigOverrides {
  provider?: string;
  baseURL?: string;
  apiKey?: string;
  model?: string;
  /** CLI 直接传入的 MCP 规格（JSON 字符串数组），优先级高于 env */
  mcp?: string;
  /** CLI 直接传入的 RAG 语料路径（逗号分隔），优先级高于 env */
  rag?: string;
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

/** 解析 MCP 服务器规格：接受 JSON 字符串，非法时回退空数组（不阻断主流程） */
function parseMcpServers(raw: string | undefined): McpServerSpec[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((x): x is McpServerSpec => !!x && typeof x.command === 'string')
      .map((x) => ({ command: x.command, args: x.args, env: x.env, cwd: x.cwd }));
  } catch {
    return [];
  }
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

  return {
    provider,
    llm: { baseURL, apiKey, model },
    mcpServers: parseMcpServers(
      firstNonEmpty('', overrides.mcp, process.env.AGENTCLI_MCP_SERVERS),
    ),
    ragPath: firstNonEmpty('', overrides.rag, process.env.AGENTCLI_RAG_PATH),
  };
}
