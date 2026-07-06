#!/usr/bin/env node
import { Command } from 'commander';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { loadConfig, type ConfigOverrides } from '../config';
import { createChatModel } from '../core/chatmodel';
import { createToolRegistry } from '../core/tools/registry';
import { EventBus } from '../core/events/bus';
import { PermissionManager } from '../core/security/permission';
import { AuditLogger } from '../core/security/audit';
import { MemoryStore } from '../core/memory/store';
import { getMemoryTools } from '../core/memory/tools';
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
  .action(async () => {
    const opts = program.opts<ConfigOverrides & { prompt?: string }>();
    const config = loadConfig({
      provider: opts.provider,
      model: opts.model,
      baseURL: opts.baseURL,
      apiKey: opts.apiKey,
    });
    const model = createChatModel(config);
    const tools = createToolRegistry();

    // Phase 4：长期记忆仓库 + 记忆工具注册
    const memory = new MemoryStore(join(homedir(), '.config', 'agent-cli', 'memory.db'));
    tools.registerAll(getMemoryTools(memory));

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

    if (opts.prompt) {
      await runOnce(model, opts.prompt, tools, permission, bus, compress);
    } else {
      await startRepl(config, model, tools, permission, bus, compress);
    }
  });

program.parseAsync(process.argv);
