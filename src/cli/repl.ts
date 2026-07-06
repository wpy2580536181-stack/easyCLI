import readline from 'node:readline';
import chalk from 'chalk';
import type { ChatMessage, ChatModel } from '../core/chatmodel';
import type { AppConfig } from '../config';
import { StreamRenderer } from './renderer';

const SYSTEM_PROMPT =
  '你是一个运行在终端里的 AI 编程助手，类似 Claude Code。用简洁、准确的中文回答用户的问题。';

export async function runOnce(model: ChatModel, prompt: string): Promise<void> {
  const renderer = new StreamRenderer(chalk.green);
  const history: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: prompt },
  ];
  const result = await model.complete({
    messages: history,
    onText: (chunk) => renderer.push(chunk),
  });
  renderer.newline();
  if (result.toolCalls.length > 0) {
    console.log(chalk.yellow(`(本次返回了 ${result.toolCalls.length} 个工具调用，Phase 2 才会执行)`));
  }
}

export async function startRepl(config: AppConfig, model: ChatModel): Promise<void> {
  const renderer = new StreamRenderer(chalk.green);
  console.log(
    chalk.bold.green('agent-cli') +
      chalk.gray(`  (${model.id})  —  输入 /help 查看命令，Ctrl+C 退出`),
  );
  if (!config.llm.apiKey) {
    console.log(
      chalk.yellow('⚠ 未检测到 API Key，请设置 AGENTCLI_API_KEY（或 OPENAI_API_KEY）后再对话。'),
    );
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: chalk.blue('你 › '),
  });
  const history: ChatMessage[] = [{ role: 'system', content: SYSTEM_PROMPT }];

  rl.prompt();
  for await (const line of rl) {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      continue;
    }
    if (input.startsWith('/')) {
      const r = await handleSlash(input, config, model, history);
      if (r === 'exit') break;
      rl.prompt();
      continue;
    }

    history.push({ role: 'user', content: input });
    const reply = await runTurn(model, history, renderer);
    history.push({ role: 'assistant', content: reply });
    rl.prompt();
  }

  rl.close();
  console.log(chalk.gray('\n再见。'));
}

async function runTurn(
  model: ChatModel,
  history: ChatMessage[],
  renderer: StreamRenderer,
): Promise<string> {
  process.stdout.write(chalk.green('\n助手 › '));
  const result = await model.complete({
    messages: history,
    onText: (chunk) => renderer.push(chunk),
  });
  renderer.newline();
  return result.content;
}

type SlashResult = 'exit' | 'continue';

async function handleSlash(
  cmd: string,
  _config: AppConfig,
  model: ChatModel,
  history: ChatMessage[],
): Promise<SlashResult> {
  const [name, ...rest] = cmd.slice(1).split(/\s+/);
  switch (name) {
    case 'exit':
    case 'quit':
      return 'exit';
    case 'clear': {
      history.length = 1; // 仅保留 system prompt
      console.log(chalk.gray('上下文已清空。'));
      return 'continue';
    }
    case 'model':
      console.log(chalk.gray(`当前模型: ${model.id}`));
      return 'continue';
    case 'help':
      printHelp();
      return 'continue';
    case 'prompt': {
      const text = rest.join(' ').trim();
      if (text) {
        history.push({ role: 'user', content: text });
        const renderer = new StreamRenderer(chalk.green);
        const reply = await runTurn(model, history, renderer);
        history.push({ role: 'assistant', content: reply });
      } else {
        console.log(chalk.yellow('用法: /prompt <你的问题>'));
      }
      return 'continue';
    }
    default:
      console.log(chalk.yellow(`未知命令: ${cmd}（输入 /help 查看可用命令）`));
      return 'continue';
  }
}

function printHelp(): void {
  console.log(
    [
      chalk.bold('可用命令：'),
      '  /help              显示本帮助',
      '  /clear             清空对话上下文（保留系统提示）',
      '  /model             显示当前模型',
      '  /prompt <文本>     单次提问（不进入多轮）',
      '  /exit, /quit       退出',
      '',
      chalk.gray('其它任意输入都会发送给模型进行多轮对话。'),
    ].join('\n'),
  );
}
