// Phase 8（模型配置持久化）：用户配置文件读写层。
//
// 配置文件位置：~/.config/agent-cli/config.json
// 作用：把「provider / model / baseURL / apiKey / 默认 MCP·RAG 源」持久化，
// 让用户只需设置一次，后续启动自动生效（作为「持久化默认」层，低于 CLI 参数与环境变量）。
//
// 设计要点：
//   - 用 zod 做 schema 校验，缺失/非法文件一律返回 null（不阻断启动，符合「配置错误应优雅降级」）。
//   - saveUserConfig 与已有文件「浅合并」，避免覆盖无关字段。
//   - maskSecret 用于终端展示时对密钥打码，绝不把明文 apiKey 打到屏幕上。

import { z } from 'zod';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import type { McpServerSpec } from '../core/mcp/client';
import type { EmbedderConfig, FallbackConfig, SearchConfig } from '../config';

/** 配置文件绝对路径（跨平台：~/.config/agent-cli/config.json） */
export const CONFIG_PATH = join(homedir(), '.config', 'agent-cli', 'config.json');

/** 用户可持久化的配置子集（AppConfig 中「可设置」的那部分） */
export interface UserConfig {
  provider?: string;
  baseURL?: string;
  apiKey?: string;
  model?: string;
  /** 是否流式输出（false 用于不支持 SSE 的网关）；默认 true，不写即流式 */
  stream?: boolean;
  mcpServers?: McpServerSpec[];
  /** 文件里用数组存，加载时 join(',') 成与 CLI/env 一致的逗号串 */
  ragPaths?: string[];
  /** Phase 11：fallback 模型配置（可选） */
  fallback?: FallbackConfig;
  /** Phase 11：RAG 嵌入器配置（可选，默认手写 TF-IDF） */
  embedder?: EmbedderConfig;
  /** Phase 18：联网搜索配置（可选；默认零 key 的 DuckDuckGo，不写即开箱即用） */
  search?: SearchConfig;
  /** 底部状态栏（statusline）开关，默认开；false 关闭 */
  statusline?: boolean;
  /** 模型上下文窗口（token）；不设置则由 provider/model 推导默认 */
  contextWindow?: number;
}

const mcpServerSchema = z.object({
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  cwd: z.string().optional(),
});

const userConfigSchema = z.object({
  provider: z.string().optional(),
  baseURL: z.string().optional(),
  apiKey: z.string().optional(),
  model: z.string().optional(),
  stream: z.boolean().optional(),
  mcpServers: z.array(mcpServerSchema).optional(),
  ragPaths: z.array(z.string()).optional(),
  fallback: z
    .object({
      provider: z.string().optional(),
      baseURL: z.string().optional(),
      apiKey: z.string().optional(),
      model: z.string().optional(),
    })
    .optional(),
  embedder: z
    .union([
      z.object({ type: z.literal('tfidf') }),
      z.object({
        type: z.literal('api'),
        baseURL: z.string(),
        apiKey: z.string(),
        model: z.string(),
        dim: z.number().optional(),
      }),
    ])
    .optional(),
  statusline: z.boolean().optional(),
  contextWindow: z.number().int().positive().optional(),
  search: z
    .object({
      provider: z.enum(['tavily', 'duckduckgo']).optional(),
      apiKey: z.string().optional(),
      maxResults: z.number().optional(),
      timeoutMs: z.number().optional(),
    })
    .optional(),
});

/**
 * 读取用户配置文件。任何异常（文件不存在/JSON 非法/schema 不匹配）都返回 null，
 * 让上层回退到「无文件」状态——配置错误绝不应让 CLI 起不来。
 */
export function loadUserConfig(path: string = CONFIG_PATH): UserConfig | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = userConfigSchema.safeParse(JSON.parse(raw));
    return parsed.success ? (parsed.data as UserConfig) : null;
  } catch {
    return null;
  }
}

/** 去掉值为 undefined 的键，便于「只覆盖显式设置的字段」 */
function stripUndefined(cfg: UserConfig): UserConfig {
  const out: UserConfig = {};
  for (const [k, v] of Object.entries(cfg)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

/**
 * 写回用户配置：与已有文件「浅合并」（existing 打底，cfg 覆盖），
 * 避免一次保存把文件里其它无关字段清掉。自动建父目录。
 */
export function saveUserConfig(cfg: UserConfig, path: string = CONFIG_PATH): void {
  const existing = loadUserConfig(path) ?? {};
  const merged: UserConfig = { ...existing, ...stripUndefined(cfg) };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(merged, null, 2), 'utf8');
}

/** 把密钥中间打码，用于终端展示（如 /config）。空串给占位提示。 */
export function maskSecret(secret: string): string {
  if (!secret) return '(空)';
  if (secret.length <= 8) return '****';
  return `${secret.slice(0, 4)}****${secret.slice(-4)}`;
}
