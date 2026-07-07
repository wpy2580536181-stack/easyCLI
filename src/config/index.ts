// 配置加载与合并。
// 优先级（高 → 低）：CLI 参数 > 环境变量 > 配置文件 > 默认值。
// 即「配置文件」是比硬编码默认值更高一层的「持久化默认」，CLI 参数与环境变量仍可临时覆盖它
// （与 CLAUDE.md §5 既定原则「CLI 参数 > 环境变量 > 默认值」一致，只是把文件插在默认值之上）。
// 这样设计：用户设一次 config.json 即长期生效，但单次运行仍可用 --model 等旗标临时改写。

import type { McpServerSpec } from '../core/mcp/client';
import { loadUserConfig, saveUserConfig, maskSecret, CONFIG_PATH, type UserConfig } from './store';

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
 * 注意：候选按「低优先级 → 高优先级」传入，本函数返回第一个非空值，故高优先级（靠后）胜出。
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

/**
 * 加载配置。
 * @param overrides CLI 旗标覆盖（最高优先级）
 * @param fileConfig 从 ~/.config/agent-cli/config.json 读取的用户配置（持久化默认层）。
 *                    不传则视为「无文件」；main.ts 会先 loadUserConfig() 再传入。
 */
export function loadConfig(overrides: ConfigOverrides = {}, fileConfig?: UserConfig | null): AppConfig {
  const file = fileConfig ?? null;

  // 单 env 字段：cands = [CLI, 环境变量, 文件]，def = 默认值。
  // firstNonEmpty 返回「第一个非空候选」，故高优先级放在 cands 最前（文件仅高于默认值）。
  const provider = firstNonEmpty(
    'openai',
    overrides.provider,
    process.env.AGENTCLI_PROVIDER,
    file?.provider,
  );
  const baseURL = firstNonEmpty(
    'https://api.deepseek.com/v1',
    overrides.baseURL,
    process.env.AGENTCLI_BASE_URL,
    file?.baseURL,
  );
  const model = firstNonEmpty(
    'deepseek-chat',
    overrides.model,
    process.env.AGENTCLI_MODEL,
    file?.model,
  );

  // apiKey 有两个 env 候选（AGENTCLI_API_KEY 优先于 OPENAI_API_KEY）。
  // cands = [CLI, AGENTCLI_API_KEY, OPENAI_API_KEY, 文件]，def = ''。整层 env 位于文件之上。
  const apiKey = firstNonEmpty(
    '',
    overrides.apiKey,
    process.env.AGENTCLI_API_KEY,
    process.env.OPENAI_API_KEY,
    file?.apiKey,
  );

  // MCP/RAG：CLI > 环境变量 > 文件 > 默认([] / '')
  const mcpFromCli = overrides.mcp ? parseMcpServers(overrides.mcp) : null;
  const mcpFromEnv = process.env.AGENTCLI_MCP_SERVERS
    ? parseMcpServers(process.env.AGENTCLI_MCP_SERVERS)
    : null;
  const mcpServers = mcpFromCli ?? mcpFromEnv ?? file?.mcpServers ?? [];

  const ragFromCli = overrides.rag || '';
  const ragFromEnv = process.env.AGENTCLI_RAG_PATH || '';
  const ragFromFile = file?.ragPaths?.join(',') ?? '';
  const ragPath = ragFromCli || ragFromEnv || ragFromFile || '';

  return {
    provider,
    llm: { baseURL, apiKey, model },
    mcpServers,
    ragPath,
  };
}

/**
 * 把「生效配置」转回可持久化结构（仅含非空字段），供 saveUserConfig 写入文件。
 * 例如 --save-config 时，把本次实际用到的 provider/model/apiKey/MCP/RAG 落盘。
 */
export function appConfigToUserConfig(cfg: AppConfig): UserConfig {
  const out: UserConfig = {};
  if (cfg.provider) out.provider = cfg.provider;
  if (cfg.llm.baseURL) out.baseURL = cfg.llm.baseURL;
  if (cfg.llm.apiKey) out.apiKey = cfg.llm.apiKey;
  if (cfg.llm.model) out.model = cfg.llm.model;
  if (cfg.mcpServers.length) out.mcpServers = cfg.mcpServers;
  if (cfg.ragPath) out.ragPaths = cfg.ragPath.split(',').map((s) => s.trim()).filter(Boolean);
  return out;
}

// 对外再导出持久化层 API，方便 main.ts / repl.ts 一处引入
export { loadUserConfig, saveUserConfig, maskSecret, CONFIG_PATH };
export type { UserConfig };
