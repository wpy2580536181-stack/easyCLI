import readline from 'node:readline';
import chalk from 'chalk';
import type { ChatMessage, ChatModel } from '../core/chatmodel';
import { type AppConfig, saveUserConfig, appConfigToUserConfig, maskSecret, CONFIG_PATH } from '../config';
import type { ToolRegistry } from '../core/tools/registry';
import type { PermissionManager, Decision, Resolver } from '../core/security/permission';
import type { EventBus } from '../core/events/bus';
import { compressHistory, type CompressOptions } from '../core/memory/compressor';
import { RagStore } from '../core/rag/store';
import { SkillLoader } from '../core/skill';
import { SessionStore, extractConversation, withSystem, AUTOSAVE_NAME } from '../core/session/store';
import { runAgent } from '../core/agent';
import { buildAgentSystemPrompt } from '../core/prompts';
import { StreamRenderer } from './renderer';
import { HistoryStore } from './history';
import { completeLine, SLASH_COMMANDS } from './completer';

/** 多行粘贴判定的 debounce 窗口：窗口内连续到达的非 slash 行视为同一次粘贴 */
const PASTE_DEBOUNCE_MS = 12;

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
  const sys = buildAgentSystemPrompt({
    cwd: process.cwd(),
    skillsMenu: skillLoader?.menuText() ?? undefined,
  });
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
  resume?: boolean,
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

  const historyStore = new HistoryStore();
  // 本地维护一份「新 → 旧」历史，用于 Tab 补全与跨会话 ↑/↓。
  // 注：新版 @types/node 的 readline.Interface 已不直接暴露可读写的 rl.history 属性，
  // 历史只能经 createInterface 的 history/historySize 选项初始化、由 readline 内部维护，
  // 故补全所需的「历史句子」我们用本地数组 mirror 一份。
  const histLines: string[] = historyStore.forReadline();
  // Phase 10：跨会话命令历史。
  // historySize>0 启用 readline 内部历史（↑/↓ 可用），初始用历史文件 seed；
  // 用户输入由 readline 自动记录，我们额外通过 HistoryStore 落盘（去重 + 限长）。
  // completer：Tab 补全（slash 命令名 / 历史句子）。
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: chalk.blue('你 › '),
    history: histLines,
    historySize: 2000,
    completer: (line: string) => {
      const { hits, line: src } = completeLine(line, SLASH_COMMANDS, histLines);
      return [hits, src] as [string[], string];
    },
  });
  const history: ChatMessage[] = [
    {
      role: 'system',
      content: buildAgentSystemPrompt({
        cwd: process.cwd(),
        skillsMenu: skillLoader?.menuText() ?? undefined,
      }),
    },
  ];
  // Phase 9：会话存储 + 跨会话恢复。每轮结束自动写 autosave，--resume 时恢复。
  const sessionStore = new SessionStore();
  if (resume && sessionStore.exists(AUTOSAVE_NAME)) {
    const loaded = sessionStore.load(AUTOSAVE_NAME);
    if (loaded) {
      const systemContent = typeof history[0]?.content === 'string' ? history[0].content : '';
      history.length = 0;
      history.push(...withSystem(loaded, systemContent));
      console_.log(chalk.gray(`⟳ 已从自动保存的会话恢复（${loaded.length} 条消息）`));
    }
  }
  const abort = new AbortController();
  rl.on('SIGINT', () => abort.abort());
  const resolver = makeResolver(rl, permission);
  // 把交互式 HITL 提示器注入权限管理器，执行器在 ask 决策时回调它
  permission.setResolver(resolver);
  let busy = false;

  async function persistAutosave(): Promise<void> {
    // 每轮结束把当前对话（不含 system）压缩后写入 autosave，供 --resume 恢复。
    // 失败不应打断用户，故吞掉异常。
    try {
      await sessionStore.save(AUTOSAVE_NAME, extractConversation(history), compress);
    } catch {
      /* 自动保存失败静默忽略 */
    }
  }

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
    })
      .then(() => r.newline())
      .then(() => {
        void persistAutosave();
      });
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
      case 'config': {
        const [sub, ...rest2] = rest;
        if (sub === 'save') {
          // 把当前生效配置落盘（与已有文件浅合并）
          saveUserConfig(appConfigToUserConfig(config));
          console_.log(chalk.gray(`已写入 ${CONFIG_PATH}`));
        } else {
          const mcp = config.mcpServers;
          const rag = config.ragPath
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
          console_.log(chalk.bold('当前配置（生效值）：'));
          console_.log(chalk.gray(`  provider : ${config.provider}`));
          console_.log(chalk.gray(`  model    : ${config.llm.model}`));
          console_.log(chalk.gray(`  baseURL  : ${config.llm.baseURL}`));
          console_.log(chalk.gray(`  apiKey   : ${maskSecret(config.llm.apiKey)}`));
          console_.log(chalk.gray(`  MCP 源   : ${mcp.length} 个`));
          console_.log(chalk.gray(`  RAG 源   : ${rag.length ? rag.join(', ') : '(空)'}`));
          console_.log(chalk.gray('（/config save 可持久化当前配置）'));
        }
        return 'continue';
      }
      case 'rag': {
        if (!ragStore) {
          console_.log(chalk.yellow('未启用 RAG：启动时请用 --rag <路径> 或设置 AGENTCLI_RAG_PATH'));
          return 'continue';
        }
        const [sub, ...rest2] = rest;
        const arg = rest2.join(' ').trim();
        if (sub === 'search' && arg) {
          const r = await ragStore.search(arg, 5);
          console_.log(RagStore.toContext(r));
        } else if (sub === 'ingest' && arg) {
          const { docs, chunks } = await ragStore.addSource(arg);
          console_.log(chalk.gray(`已增量索引 ${arg}：共 ${docs} 文档 / ${chunks} 片段`));
        } else if (sub === 'reindex') {
          const { docs, chunks } = await ragStore.reindex();
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
      case 'save': {
        const sname = rest[0]?.trim() || 'default';
        await sessionStore.save(sname, extractConversation(history), compress);
        console_.log(chalk.gray(`已保存会话「${sname}」（${history.length - 1} 条消息）`));
        return 'continue';
      }
      case 'load': {
        const sname = rest[0]?.trim() || 'default';
        const loaded = sessionStore.load(sname);
        if (!loaded) {
          console_.log(chalk.yellow(`未找到会话: ${sname}`));
          return 'continue';
        }
        const systemContent = typeof history[0]?.content === 'string' ? history[0].content : '';
        history.length = 0;
        history.push(...withSystem(loaded, systemContent));
        console_.log(chalk.gray(`已载入会话「${sname}」（${loaded.length} 条消息）`));
        return 'continue';
      }
      case 'sessions': {
        const list = sessionStore.list();
        if (list.length === 0) {
          console_.log(chalk.gray('（当前无已保存会话）'));
        } else {
          for (const s of list) {
            console_.log(
              chalk.gray(`- ${s.name} ：${s.messageCount} 条消息，更新于 ${new Date(s.updatedAt).toLocaleString()}`),
            );
          }
        }
        return 'continue';
      }
      case 'session': {
        const sname = rest[0]?.trim();
        if (!sname) {
          console_.log(chalk.yellow('用法: /session <会话名>'));
          return 'continue';
        }
        const loaded = sessionStore.load(sname);
        if (!loaded) {
          console_.log(chalk.yellow(`未找到会话: ${sname}`));
          return 'continue';
        }
        console_.log(chalk.bold(`会话「${sname}」（${loaded.length} 条）预览：`));
        for (const m of loaded) {
          const full =
            typeof m.content === 'string'
              ? m.content
              : m.content.map((b) => (b.type === 'text' ? b.text : `[${b.type}]`)).join('');
          const preview = full.slice(0, 200);
          console_.log(chalk.gray(`  [${m.role}] ${preview}${full.length > 200 ? '…' : ''}`));
        }
        return 'continue';
      }
      case 'rm': {
        const sname = rest[0]?.trim();
        if (!sname) {
          console_.log(chalk.yellow('用法: /rm <会话名>'));
          return 'continue';
        }
        const ok = sessionStore.remove(sname);
        console_.log(ok ? chalk.gray(`已删除会话「${sname}」`) : chalk.yellow(`未找到会话: ${sname}`));
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

  /** 处理一条输入：slash 走命令，普通文本入 history 并跑一轮 */
  async function processInput(input: string): Promise<'exit' | 'continue'> {
    if (input.startsWith('/')) return handleSlash(input);
    history.push({ role: 'user', content: input });
    process.stdout.write(chalk.green('\n助手 › '));
    await runTurn();
    return 'continue';
  }

  // ---- Phase 10：输入处理（多行粘贴缓冲 + 命令历史 + 跨会话队列） ----
  // busy/pending：模型生成期间到达的输入不丢弃，排队在本轮结束后顺序处理（沿用 Phase 9 修正）。
  // lineBuf/flushTimer：连续到达的「非 slash」行（通常是一次粘贴）合并为一条消息，
  //   避免 readline 把多行粘贴拆成 N 条输入；slash 命令则原子逐条处理，保证可管道化、可逐条执行。
  const pending: string[] = [];
  const lineBuf: string[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  /** 真正的「取一条输入去执行」入口：busy 时排队，否则立即跑 */
  function dispatch(input: string): void {
    if (busy) {
      pending.push(input);
      return;
    }
    busy = true;
    void (async () => {
      let exited = false;
      try {
        exited = (await processInput(input)) === 'exit';
        // 排空排队输入（退出则停止）
        while (!exited && pending.length) {
          const next = pending.shift()!;
          exited = (await processInput(next)) === 'exit';
        }
      } finally {
        busy = false;
        if (!exited) rl.prompt();
      }
    })();
  }

  /** 多行缓冲窗口到点：把累积的行合并成一条输入送出 */
  function flushLines(): void {
    flushTimer = null;
    const combined = lineBuf.join('\n');
    lineBuf.length = 0;
    if (!combined.trim()) {
      rl.prompt();
      return;
    }
    recordHistory(combined);
    dispatch(combined);
  }

  /** 记一条命令到跨会话历史（去重 + 落盘 + 同步本地历史供 Tab 补全） */
  function recordHistory(line: string): void {
    const t = line.trim();
    if (!t) return;
    historyStore.add(t);
    if (histLines[0] !== t) {
      histLines.unshift(t);
      if (histLines.length > 2000) histLines.length = 2000;
    }
  }

  rl.on('line', (line) => {
    const input = line.trim();
    if (!input) {
      // 空行：若正处于多行粘贴缓冲中，归并入缓冲（代码粘贴常含空行）；否则忽略
      if (lineBuf.length) {
        lineBuf.push('');
        if (flushTimer) clearTimeout(flushTimer);
        flushTimer = setTimeout(flushLines, PASTE_DEBOUNCE_MS);
      } else {
        rl.prompt();
      }
      return;
    }
    if (input.startsWith('/')) {
      // slash 命令：原子处理，不进入多行缓冲（保证可管道化、可逐条执行）。
      // 但若缓冲里还有未触发的多行文本（如「多行提示 + /exit」），先把它作为一条消息送出，
      // 再处理 slash——否则直接清定时器会丢弃前面的输入。
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      if (lineBuf.length) {
        flushLines(); // 清空缓冲并 dispatch 合并文本（可能进入 busy，slash 随后排队）
      }
      recordHistory(input);
      dispatch(input);
      return;
    }
    // 普通文本：进入多行缓冲，短窗内到达的后续行视为同一次粘贴
    lineBuf.push(line);
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(flushLines, PASTE_DEBOUNCE_MS);
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
      '  /config            查看当前生效配置（密钥打码）；/config save 持久化',
      '  /save [名称]       保存当前会话（默认名 default）',
      '  /load [名称]       载入已保存会话（默认名 default）',
      '  /sessions          列出所有已保存会话',
      '  /session <名称>    预览某会话内容',
      '  /rm <名称>         删除某会话',
      '  /prompt <文本>     单次提问（不进入多轮）',
      '  /exit, /quit       退出',
      '',
      chalk.gray('交互提示：Tab 补全命令 · ↑↓ 翻历史（跨会话持久）· 直接粘贴多行代码作为「一条消息」'),
      chalk.gray('模型可自主调用 read_file / write_file / edit_file / list_dir / glob / grep / bash 完成多步任务。'),
    ].join('\n'),
  );
}
