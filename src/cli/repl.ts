import readline from 'node:readline';
import chalk from 'chalk';
import type { ChatMessage, ChatModel } from '../core/chatmodel';
import type { AppConfig } from '../config';
import type { ToolRegistry } from '../core/tools/registry';
import type { PermissionManager, Decision, Resolver } from '../core/security/permission';
import type { EventBus } from '../core/events/bus';
import type { CompressOptions } from '../core/memory/compressor';
import { RagStore } from '../core/rag/store';
import { SkillLoader } from '../core/skill';
import { runAgent } from '../core/agent';
import { StreamRenderer } from './renderer';

const SYSTEM_PROMPT =
  '你是一个运行在终端里的 AI 编程助手，类似 Claude Code。用简洁、准确的中文回答用户的问题；' +
  '需要操作文件或执行命令时，优先调用工具：read_file / write_file / edit_file / list_dir / glob / grep / bash。' +
  '若已提供 rag_search 工具（本地知识库语义检索），在回答涉及项目文档、规范、历史决策等问题前，应先检索补充上下文。' +
  '若下方列出「可用技能」，在任务匹配时应调用 use_skill 获取其详细指令并严格遵循。';

/** 构造 HITL 审批器：交互式询问用户是否放行（y/n/a），a 表示持久预批准 */
function makeResolver(rl: readline.Interface, permission: PermissionManager): Resolver {
  return (tool: string, detail: string): Promise<Decision> =>
    new Promise<Decision>((resolve) => {
      const q = chalk.yellow(
        `⚠ 允许执行 ${tool}${detail ? ' › ' + detail : ''} ? [y=允许 / n=拒绝 / a=总是允许] `,
      );
      rl.question(q, (ans) => {
        const a = ans.trim().toLowerCase();
        if (a === 'a' || a === 'always') {
          permission.addAllow(tool);
          resolve('allow');
        } else if (a === 'y' || a === 'yes') {
          resolve('allow');
        } else {
          resolve('deny');
        }
      });
    });
}

export async function runOnce(
  model: ChatModel,
  prompt: string,
  tools: ToolRegistry,
  permission: PermissionManager,
  bus: EventBus,
  compress?: CompressOptions,
  ragStore?: RagStore | null,
  skillLoader?: SkillLoader | null,
): Promise<void> {
  const renderer = new StreamRenderer(chalk.green);
  const sys = SYSTEM_PROMPT + (skillLoader?.menuText() ? '\n\n' + skillLoader.menuText()! : '');
  const history: ChatMessage[] = [
    { role: 'system', content: sys },
    { role: 'user', content: prompt },
  ];
  // 非交互模式无 HITL 提示：默认只读工具放行，写/危险操作被拒（安全默认）
  await runAgent(history, {
    model,
    tools,
    permission,
    bus,
    compress,
    cwd: process.cwd(),
    onText: (c) => renderer.push(c),
    onToolCall: (call) => renderer.status(`🔧 调用工具 ${call.name}`),
    onToolResult: (call, res) =>
      renderer.status(`${res.ok ? '✓' : '✗'} ${call.name} 返回 ${String(res.output).length} 字符`),
  });
  renderer.newline();
}

export async function startRepl(
  config: AppConfig,
  model: ChatModel,
  tools: ToolRegistry,
  permission: PermissionManager,
  bus: EventBus,
  compress?: CompressOptions,
  ragStore?: RagStore | null,
  skillLoader?: SkillLoader | null,
): Promise<void> {
  const console_ = console;
  console_.log(
    chalk.bold.green('agent-cli') +
      chalk.gray(`  (${model.id})  —  输入 /help 查看命令，Ctrl+C 中断当前生成`),
  );
  if (!config.llm.apiKey) {
    console_.log(
      chalk.yellow('⚠ 未检测到 API Key，请设置 AGENTCLI_API_KEY（或 OPENAI_API_KEY）后再对话。'),
    );
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: chalk.blue('你 › '),
  });
  const history: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT + (skillLoader?.menuText() ? '\n\n' + skillLoader.menuText()! : '') },
  ];
  const abort = new AbortController();
  rl.on('SIGINT', () => abort.abort());
  const resolver = makeResolver(rl, permission);
  // 把交互式 HITL 提示器注入权限管理器，执行器在 ask 决策时回调它
  permission.setResolver(resolver);
  let busy = false;

  function runTurn(): Promise<void> {
    const r = new StreamRenderer(chalk.green);
    return runAgent(history, {
      model,
      tools,
      permission,
      bus,
      compress,
      signal: abort.signal,
      cwd: process.cwd(),
      onText: (c) => r.push(c),
      onToolCall: (call) => r.status(`🔧 调用工具 ${call.name}`),
      onToolResult: (call, res) => r.status(`${res.ok ? '✓' : '✗'} ${call.name}`),
      onCompact: (info) => r.status(`⟳ 上下文已压缩 ${info.before}→${info.after} token`),
    }).then(() => r.newline());
  }

  async function handleSlash(cmd: string): Promise<'exit' | 'continue'> {
    const [name, ...rest] = cmd.slice(1).split(/\s+/);
    switch (name) {
      case 'exit':
      case 'quit':
        return 'exit';
      case 'clear':
        history.length = 1;
        console_.log(chalk.gray('上下文已清空。'));
        return 'continue';
      case 'model':
        console_.log(chalk.gray(`当前模型: ${model.id}`));
        return 'continue';
      case 'tools':
        console_.log(chalk.gray(`已注册工具: ${tools.list().map((t) => t.name).join(', ')}`));
        return 'continue';
      case 'perm':
        console_.log(chalk.gray(`允许: ${permission.getAllow().join(', ') || '(空)'}`));
        console_.log(chalk.gray(`拒绝: ${permission.getDeny().join(', ') || '(空)'}`));
        return 'continue';
      case 'rag': {
        if (!ragStore) {
          console_.log(chalk.yellow('未启用 RAG：启动时请用 --rag <路径> 或设置 AGENTCLI_RAG_PATH'));
          return 'continue';
        }
        const [sub, ...rest2] = rest;
        const arg = rest2.join(' ').trim();
        if (sub === 'search' && arg) {
          const r = ragStore.search(arg, 5);
          console_.log(RagStore.toContext(r));
        } else if (sub === 'ingest' && arg) {
          const { docs, chunks } = ragStore.addSource(arg);
          console_.log(chalk.gray(`已增量索引 ${arg}：共 ${docs} 文档 / ${chunks} 片段`));
        } else if (sub === 'reindex') {
          const { docs, chunks } = ragStore.reindex();
          console_.log(chalk.gray(`已重建索引：${docs} 文档 / ${chunks} 片段`));
        } else if (sub === 'status') {
          const s = ragStore.status();
          console_.log(chalk.gray(`RAG 状态：文档 ${s.docs} / 片段 ${s.chunks} / 维度 ${s.dim}`));
          console_.log(chalk.gray(`来源: ${ragStore.getSources().join(', ') || '(空)'}`));
        } else {
          console_.log(
            chalk.yellow('用法: /rag <search|ingest|reindex|status> [参数]'),
          );
        }
        return 'continue';
      }
      case 'skills': {
        const list = skillLoader?.list() ?? [];
        if (list.length === 0) {
          console_.log(chalk.gray('（当前无已加载技能）'));
        } else {
          for (const s of list) {
            console_.log(chalk.gray(`- ${s.name} [${s.layer}]：${s.description}`));
          }
        }
        return 'continue';
      }
      case 'skill': {
        const name = rest.join(' ').trim();
        if (!name) {
          console_.log(chalk.yellow('用法: /skill <技能名>'));
          return 'continue';
        }
        const skill = skillLoader?.load(name);
        if (!skill) {
          console_.log(chalk.yellow(`未找到技能: ${name}`));
        } else {
          console_.log(chalk.bold(`技能：${skill.name}`) + chalk.gray(`（来源 ${skill.layer}）`));
          console_.log(skill.body.trim());
        }
        return 'continue';
      }
      case 'help':
        printHelp();
        return 'continue';
      case 'prompt': {
        const text = rest.join(' ').trim();
        if (text) {
          history.push({ role: 'user', content: text });
          process.stdout.write(chalk.green('\n助手 › '));
          await runTurn();
        } else {
          console_.log(chalk.yellow('用法: /prompt <你的问题>'));
        }
        return 'continue';
      }
      default:
        console_.log(chalk.yellow(`未知命令: ${cmd}（输入 /help 查看可用命令）`));
        return 'continue';
    }
  }

  async function processLine(input: string): Promise<'exit' | 'continue'> {
    if (input.startsWith('/')) return handleSlash(input);
    history.push({ role: 'user', content: input });
    process.stdout.write(chalk.green('\n助手 › '));
    await runTurn();
    return 'continue';
  }

  rl.on('line', async (line) => {
    if (busy) return;
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }
    busy = true;
    let exited = false;
    try {
      exited = (await processLine(input)) === 'exit';
    } finally {
      busy = false;
      if (!exited) rl.prompt();
    }
  });

  rl.prompt();
}

function printHelp(): void {
  console.log(
    [
      chalk.bold('可用命令：'),
      '  /help              显示本帮助',
      '  /clear             清空对话上下文（保留系统提示）',
      '  /model             显示当前模型',
      '  /tools             显示已注册工具',
      '  /rag               知识库：/rag search <q> | ingest <路径> | reindex | status',
      '  /skills            列出已加载技能',
      '  /skill <name>      查看某技能的完整指令',
      '  /perm              显示当前权限允许/拒绝列表',
      '  /prompt <文本>     单次提问（不进入多轮）',
      '  /exit, /quit       退出',
      '',
      chalk.gray('模型可自主调用 read_file / write_file / edit_file / list_dir / glob / grep / bash 完成多步任务。'),
    ].join('\n'),
  );
}
