// 配置加载与合并。
// 优先级（高 → 低）：CLI 参数 > 环境变量 > 配置文件 > 默认值。
// 即「配置文件」是比硬编码默认值更高一层的「持久化默认」，CLI 参数与环境变量仍可临时覆盖它
// （与 CLAUDE.md §5 既定原则「CLI 参数 > 环境变量 > 默认值」一致，只是把文件插在默认值之上）。
// 这样设计：用户设一次 config.json 即长期生效，但单次运行仍可用 --model 等旗标临时改写。

import type { McpServerSpec } from '../core/mcp/client';
import type { EmbedderConfig } from '../core/rag/embedder';
import { loadUserConfig, saveUserConfig, maskSecret, CONFIG_PATH, type UserConfig } from './store';

// 供 store.ts / 上层一处引入嵌入器配置类型
export type { EmbedderConfig };

export interface LlmConfig {
  baseURL: string;
  apiKey: string;
  model: string;
  /** 是否流式输出；false 用于不支持 SSE 的网关（如 agnes）。默认 true */
  stream?: boolean;
}

/** fallback 模型配置（决策 10：主模型失败自动切换备用） */
export interface FallbackConfig {
  provider?: string;
  baseURL?: string;
  apiKey?: string;
  model?: string;
}

export interface AppConfig {
  provider: string;
  llm: LlmConfig;
  /** Phase 5：要连接的 MCP Server 列表（stdio），可为空 */
  mcpServers: McpServerSpec[];
  /** Phase 6：RAG 语料源（文件/目录，逗号分隔），可为空 */
  ragPath: string;
  /** Phase 11：fallback 模型（可选）；配置且含 model 时启用降级 */
  fallback?: FallbackConfig;
  /** Phase 11：RAG 嵌入器配置；默认手写 TF-IDF（离线） */
  embedder: EmbedderConfig;
}

export interface ConfigOverrides {
  provider?: string;
  baseURL?: string;
  apiKey?: string;
  model?: string;
  /** 关闭流式输出（部分网关不支持 SSE）。CLI --no-stream 传入 */
  stream?: boolean;
  /** CLI 直接传入的 MCP 规格（JSON 字符串数组），优先级高于 env */
  mcp?: string;
  /** CLI 直接传入的 RAG 语料路径（逗号分隔），优先级高于 env */
  rag?: string;
  /** CLI 直接传入的 fallback 配置（JSON 字符串），优先级高于 env/file */
  fallback?: string;
  /** CLI 直接传入的 embedder 配置（JSON 字符串），优先级高于 env/file */
  embedder?: string;
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

/** 解析 JSON 对象（CLI/env 传来的配置片段）：非法时回退 undefined（不阻断启动） */
function parseJsonObject<T extends object>(raw: string | undefined): T | undefined {
  if (!raw) return undefined;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? (v as T) : undefined;
  } catch {
    return undefined;
  }
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

  // apiKey 候选优先级（高 → 低）：
  //   CLI 旗标 > AGENTCLI_API_KEY（项目专属，显式覆盖）> 配置文件(config.json) >
  //   OPENAI_API_KEY（通用全局变量，常被其它工具设给 ChatGPT 等）> 默认('')。
  // 关键点：通用 OPENAI_API_KEY 置于「文件之下」，避免全局变量静默覆盖本项目的 config.json；
  //   只有项目专属的 AGENTCLI_API_KEY 才允许覆盖文件。baseURL/model 同理只有 AGENTCLI_* 能覆盖文件，无通用全局变量冲突。
  const apiKey = firstNonEmpty(
    '',
    overrides.apiKey,
    process.env.AGENTCLI_API_KEY,
    file?.apiKey,
    process.env.OPENAI_API_KEY,
  );

  // stream：布尔开关，优先级 CLI > 环境变量(AGENTCLI_STREAM=false) > 文件 > 默认 true。
  // 用字符串比较统一处理（env 只能是字符串），非 'false'/'0' 均视为 true。
  const streamRaw =
    overrides.stream !== undefined
      ? String(overrides.stream)
      : process.env.AGENTCLI_STREAM !== undefined
        ? process.env.AGENTCLI_STREAM
        : file?.stream !== undefined
          ? String(file.stream)
          : 'true';
  const stream = streamRaw === 'false' || streamRaw === '0' ? false : true;

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

  // Phase 11：fallback 模型（决策 10）。优先级：CLI > env > file；缺 model 视为未配置。
  // 未显式给的字段（provider/baseURL/apiKey）回退到主模型对应值，让「只换 model」成为常见用法。
  const fbCli = parseJsonObject<FallbackConfig>(overrides.fallback);
  const fbEnv = parseJsonObject<FallbackConfig>(process.env.AGENTCLI_FALLBACK);
  const fbSrc = fbCli ?? fbEnv ?? file?.fallback;
  const fallback: FallbackConfig | undefined = fbSrc
    ? {
        provider: fbSrc.provider ?? provider,
        baseURL: fbSrc.baseURL ?? baseURL,
        apiKey: fbSrc.apiKey ?? apiKey,
        model: fbSrc.model ?? '',
      }
    : undefined;
  const fallbackFinal = fallback && fallback.model ? fallback : undefined;

  // Phase 11：嵌入器（手写 TF-IDF / API）。优先级：CLI > env > file > 默认 tfidf（离线零依赖）。
  const embCli = parseJsonObject<EmbedderConfig>(overrides.embedder);
  const embEnv = parseJsonObject<EmbedderConfig>(process.env.AGENTCLI_EMBEDDER);
  const embedder: EmbedderConfig = embCli ?? embEnv ?? file?.embedder ?? { type: 'tfidf' };

  return {
    provider,
    llm: { baseURL, apiKey, model, stream },
    mcpServers,
    ragPath,
    fallback: fallbackFinal,
    embedder,
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
  // 仅在显式关闭流式时落盘，避免把默认 true 写进文件造成冗余
  if (cfg.llm.stream === false) out.stream = false;
  if (cfg.mcpServers.length) out.mcpServers = cfg.mcpServers;
  if (cfg.ragPath) out.ragPaths = cfg.ragPath.split(',').map((s) => s.trim()).filter(Boolean);
  if (cfg.fallback && cfg.fallback.model) out.fallback = cfg.fallback;
  // 手写 TF-IDF 是默认值，无需落盘；只有切换到 API 嵌入器时才持久化，避免冗余配置
  if (cfg.embedder && cfg.embedder.type !== 'tfidf') out.embedder = cfg.embedder;
  return out;
}

// 对外再导出持久化层 API，方便 main.ts / repl.ts 一处引入
export { loadUserConfig, saveUserConfig, maskSecret, CONFIG_PATH };
export type { UserConfig };
