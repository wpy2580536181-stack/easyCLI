#!/usr/bin/env node
import { Command } from 'commander';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  loadConfig,
  appConfigToUserConfig,
  loadUserConfig,
  saveUserConfig,
  CONFIG_PATH,
  type ConfigOverrides,
} from '../config';
import { createChatModel } from '../core/chatmodel';
import { createToolRegistry } from '../core/tools/registry';
import { EventBus } from '../core/events/bus';
import { PermissionManager } from '../core/security/permission';
import { AuditLogger } from '../core/security/audit';
import { MemoryStore } from '../core/memory/store';
import { getMemoryTools } from '../core/memory/tools';
import { connectMcpServers, type McpClient } from '../core/mcp/client';
import { RagStore } from '../core/rag/store';
import { getRagTools } from '../core/rag/tools';
import { SkillLoader, getSkillTools, type SkillSource } from '../core/skill';
import type { CompressOptions } from '../core/memory/compressor';
import { runOnce, startRepl } from './repl';

const program = new Command();

program
  .name('agent-cli')
  .description('从零手搓的仿 Claude Code 命令行 Agent CLI')
  .option('-p, --prompt <text>', '单次查询模式（不进入交互 REPL）')
  .option('--provider <provider>', '模型 provider（默认 openai）')
  .option('--model <model>', '模型名（如 deepseek-chat）')
  .option('--base-url <url>', 'API base url')
  .option('--api-key <key>', 'API key')
  .option('--mcp <json>', 'MCP 服务器规格（JSON 数组），如 \'[{"command":"node","args":["srv.mjs"]}]\'')
  .option('--rag <paths>', 'RAG 语料路径（文件或目录，逗号分隔）')
  .option('--save-config', '把本次生效配置写入 ~/.config/agent-cli/config.json（持久化）')
  .action(async () => {
    const opts = program.opts<ConfigOverrides & { prompt?: string; saveConfig?: boolean }>();
    // Phase 8：先读持久化配置（作为「持久化默认」层），再与 CLI/env 合并
    const fileCfg = loadUserConfig();
    const config = loadConfig(
      {
        provider: opts.provider,
        model: opts.model,
        baseURL: opts.baseURL,
        apiKey: opts.apiKey,
        mcp: opts.mcp,
        rag: opts.rag,
      },
      fileCfg,
    );
    // --save-config：把本次生效配置落盘（与已有文件浅合并）
    if (opts.saveConfig) {
      saveUserConfig(appConfigToUserConfig(config));
      console.log(`[config] 已写入 ${CONFIG_PATH}`);
    }
    const model = createChatModel(config);
    const tools = createToolRegistry();

    // Phase 4：长期记忆仓库 + 记忆工具注册
    const memory = new MemoryStore(join(homedir(), '.config', 'agent-cli', 'memory.db'));
    tools.registerAll(getMemoryTools(memory));

    // Phase 6：RAG 知识库（如配置了语料源则建索引并注册检索工具）
    let ragStore: RagStore | undefined;
    const ragSources = config.ragPath
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (ragSources.length > 0) {
      ragStore = new RagStore(join(homedir(), '.config', 'agent-cli', 'rag.db'));
      ragStore.setSources(ragSources);
      if (ragStore.status().chunks === 0) {
        const { docs, chunks } = ragStore.reindex();
        console.log(`[RAG] 已索引 ${docs} 个文档 / ${chunks} 个片段`);
      }
      tools.registerAll(getRagTools(ragStore));
    }

    // Phase 7：Skill 系统（三层加载 + 渐进式披露）
    const skillBuiltinDirs = (process.env.AGENTCLI_SKILLS_BUILTIN ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((dir) => ({ layer: 'builtin' as const, dir }));
    const skillSources: SkillSource[] = [
      ...skillBuiltinDirs,
      { layer: 'user', dir: join(homedir(), '.config', 'agent-cli', 'skills') },
      { layer: 'project', dir: join(process.cwd(), '.agent', 'skills') },
    ];
    const skillLoader = new SkillLoader(skillSources);
    tools.registerAll(getSkillTools(skillLoader));

    // Phase 5：连接并注册 MCP Server 工具（与内置工具进同一张表）
    const mcpClients: McpClient[] = await connectMcpServers(
      config.mcpServers,
      tools,
      { timeoutMs: 30_000, connectTimeoutMs: 15_000 },
      (m) => console.log(m),
    );

    // Phase 3：事件总线 + 权限 + 审计日志
    const bus = new EventBus();
    const permission = new PermissionManager({ registry: tools });
    permission.load(); // 加载已持久化的 allow/deny
    new AuditLogger(join(homedir(), '.config', 'agent-cli', 'audit.jsonl')).attach(bus);

    // Phase 4：上下文压缩配置（超预算时自动压缩后重试）
    const compress: CompressOptions = {
      budgetTokens: 8000,
      keepRecentTurns: 4,
      maxToolOutputChars: 1500,
    };

    // 退出时回收 MCP 子进程，避免孤儿进程
    const shutdownMcp = (): Promise<unknown> =>
      Promise.allSettled(mcpClients.map((c) => c.disconnect()));
    process.on('SIGINT', () => void shutdownMcp());

    if (opts.prompt) {
      await runOnce(model, opts.prompt, tools, permission, bus, compress, ragStore, skillLoader);
      await shutdownMcp();
    } else {
      await startRepl(config, model, tools, permission, bus, compress, ragStore, skillLoader);
      await shutdownMcp();
    }
  });

program.parseAsync(process.argv);
