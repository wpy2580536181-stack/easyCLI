#!/usr/bin/env node
import { Command } from 'commander';
import { loadConfig, type ConfigOverrides } from '../config';
import { createChatModel } from '../core/chatmodel';
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

    if (opts.prompt) {
      await runOnce(model, opts.prompt);
    } else {
      await startRepl(config, model);
    }
  });

program.parseAsync(process.argv);
