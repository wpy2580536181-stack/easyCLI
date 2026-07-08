import chalk from 'chalk';
import { LineEditor } from './line-editor';
import type { ChatMessage, ChatModel } from '../core/chatmodel';
import { type AppConfig, saveUserConfig, appConfigToUserConfig, maskSecret, CONFIG_PATH } from '../config';
import type { ToolRegistry } from '../core/tools/registry';
import type { PermissionManager, Decision, Resolver } from '../core/security/permission';
import type { EventBus } from '../core/events/bus';
import { compressHistory, type CompressOptions } from '../core/memory/compressor';
import { MemoryStore } from '../core/memory/store';
import { RagStore } from '../core/rag/store';
import { buildAutoContext, lastUserText, type AutoContextResult } from '../core/context';
import { SkillLoader } from '../core/skill';
import { SessionStore, extractConversation, withSystem, AUTOSAVE_NAME } from '../core/session/store';
import { runAgent } from '../core/agent';
import { buildAgentSystemPrompt, buildPlanSystemPrompt, type AgentMode } from '../core/prompts';
import { formatSnapshot, formatTokens, formatUSD, type CostTracker, type TrackerSnapshot } from '../core/observability';
import { StreamRenderer } from './renderer';
import { HistoryStore } from './history';
import { COMMANDS } from './commands';
import { printSplash } from './splash';

/** 多行粘贴判定的 debounce 窗口：窗口内连续到达的非 slash 行视为同一次粘贴 */
const PASTE_DEBOUNCE_MS = 12;

/** 构造 HITL 审批器：交互式询问用户是否放行（y/n/a），a 表示持久预批准 */
function makeResolver(editor: LineEditor, permission: PermissionManager): Resolver {
  return (tool: string, detail: string): Promise<Decision> =>
    editor
      .ask(
        chalk.yellow(
          `⚠ 允许执行 ${tool}${detail ? ' › ' + detail : ''} ? [y=允许 / n=拒绝 / a=总是允许] `,
        ),
      )
      .then((ans) => {
        const a = ans.trim().toLowerCase();
        if (a === 'a' || a === 'always') {
          permission.addAllow(tool);
          return 'allow' as Decision;
        }
        if (a === 'y' || a === 'yes') return 'allow' as Decision;
        return 'deny' as Decision;
      });
}

export async function runOnce(
  model: ChatModel,
  prompt: string,
  tools: ToolRegistry,
  permission: PermissionManager,
  bus: EventBus,
  tracker: CostTracker,
  compress?: CompressOptions,
  ragStore?: RagStore | null,
  skillLoader?: SkillLoader | null,
  memory?: MemoryStore | null,
  autoContextEnabled?: boolean,
  planMode?: boolean,
): Promise<void> {
  const renderer = new StreamRenderer(chalk.green);
  const sysCtx = { cwd: process.cwd(), skillsMenu: skillLoader?.menuText() ?? undefined };
  const sys = planMode ? buildPlanSystemPrompt(sysCtx) : buildAgentSystemPrompt(sysCtx);
  const history: ChatMessage[] = [
    { role: 'system', content: sys },
    { role: 'user', content: prompt },
  ];
  if (planMode) console.log(chalk.bold.yellow('（规划模式：仅生成计划，不执行）'));
  // Phase 16：单次模式也自动注入上下文（基于 prompt 检索记忆/知识库）
  let autoContext: string | undefined;
  if (autoContextEnabled ?? true) {
    const ac = await buildAutoContext(prompt, { memory, ragStore });
    if (ac.text) {
      autoContext = ac.text;
      renderer.status(`⚡ 自动注入上下文：记忆 ${ac.memoryCount} 条 / 知识库 ${ac.ragCount} 段`);
    }
  }
  // 非交互模式无 HITL 提示：默认只读工具放行，写/危险操作被拒（安全默认）
  await runAgent(history, {
    model,
    tools,
    permission,
    bus,
    compress,
    cwd: process.cwd(),
    planMode,
    autoContext,
    onText: (c) => renderer.push(c),
    onToolCall: (call) => renderer.status(`🔧 调用工具 ${call.name}`),
    onToolResult: (call, res) =>
      renderer.status(`${res.ok ? '✓' : '✗'} ${call.name} 返回 ${String(res.output).length} 字符`),
  });
  renderer.newline();
  // Phase 14：打印本次会话总成本（单次模式，单轮即累计）
  console.log(chalk.gray(`💰 ${formatSnapshot(tracker.endTurn(), tracker.snapshot())}`));
}

export async function startRepl(
  config: AppConfig,
  model: ChatModel,
  tools: ToolRegistry,
  permission: PermissionManager,
  bus: EventBus,
  tracker: CostTracker,
  compress?: CompressOptions,
  ragStore?: RagStore | null,
  skillLoader?: SkillLoader | null,
  memory?: MemoryStore | null,
  autoContextEnabled?: boolean,
  resume?: boolean,
): Promise<void> {
  const console_ = console;
  // 启动欢迎面板（Splash）：显示项目信息 + 运行信息（模型 / git 分支）
  printSplash({ modelId: model.id });
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
  // 输入编辑器：TTY 下用 raw mode 自绘（含斜杠命令下拉菜单），非 TTY 回退 readline。
  const promptStr = chalk.blue('你 › ');
  const editor = new LineEditor({
    prompt: promptStr,
    history: histLines,
    commands: COMMANDS,
    onSubmit: (line: string) => {
      recordHistory(line);
      dispatch(line);
    },
    onInterrupt: () => {
      if (busy) abort.abort();
      else editor.exit();
    },
  });
  // 规划模式（Phase 15）需要「切换系统提示」：把正常/规划两套系统提示都准备好，
  // 进入/退出规划模式时只替换 history[0].content，不另起引擎。
  const sysCtx = { cwd: process.cwd(), skillsMenu: skillLoader?.menuText() ?? undefined };
  const history: ChatMessage[] = [
    {
      role: 'system',
      content: buildAgentSystemPrompt(sysCtx),
    },
  ];
  // 模式与批准状态（Phase 15）
  let mode: AgentMode = 'normal';
  let normalSys = buildAgentSystemPrompt(sysCtx);
  let awaitingApproval = false;
  let planCheckpoint = 0;
  // Phase 16：自动上下文注入开关（默认开；可用 /autoctx 切换）
  let autoCtxEnabled = autoContextEnabled ?? true;

  /** 切换运行模式：替换 system 消息内容（normal <-> plan），其余 history 不动 */
  function setMode(m: AgentMode): void {
    mode = m;
    const content = m === 'plan' ? buildPlanSystemPrompt(sysCtx) : normalSys;
    if (history[0] && typeof history[0].content === 'string') history[0].content = content;
  }
  // Phase 9：会话存储 + 跨会话恢复。每轮结束自动写 autosave，--resume 时恢复。
  const sessionStore = new SessionStore();
  if (resume && sessionStore.exists(AUTOSAVE_NAME)) {
    const loaded = sessionStore.load(AUTOSAVE_NAME);
    if (loaded) {
      const systemContent = typeof history[0]?.content === 'string' ? history[0].content : '';
      history.length = 0;
      history.push(...withSystem(loaded, systemContent));
      // 恢复后把 normalSys 同步成实际 system，保证 /plan→/discard 切换时 system 不丢
      if (typeof history[0]?.content === 'string') normalSys = history[0].content;
      console_.log(chalk.gray(`⟳ 已从自动保存的会话恢复（${loaded.length} 条消息）`));
    }
  }
  const abort = new AbortController();
  // Ctrl+C：由 LineEditor 捕获后回调 onInterrupt —— 模型生成中（busy）先取消当前轮，
  // 空闲时直接退出（editor.exit() → 触发 startRepl 的 Promise resolve → main 清理后退出）。
  // 注：全局 process.on('SIGINT')（main.ts）只负责关 MCP，不会终止进程。
  const resolver = makeResolver(editor, permission);
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

  /** Phase 16：根据最新用户输入，自动检索记忆/知识库拼出本轮要注入的上下文 */
  async function autoCtxForTurn(): Promise<AutoContextResult | undefined> {
    if (!autoCtxEnabled) return undefined;
    const q = lastUserText(history);
    if (!q) return undefined;
    const res = await buildAutoContext(q, { memory, ragStore });
    return res.text ? res : undefined;
  }

  async function runTurn(): Promise<void> {
    const r = new StreamRenderer(chalk.green);
    tracker.beginTurn();
    // Phase 16：自动上下文注入（记忆 + 知识库），作为临时系统消息进入本轮模型调用
    const ac = await autoCtxForTurn();
    if (ac && ac.text) {
      r.status(`⚡ 自动注入上下文：记忆 ${ac.memoryCount} 条 / 知识库 ${ac.ragCount} 段`);
    }
    await runAgent(history, {
      model,
      tools,
      permission,
      bus,
      compress,
      signal: abort.signal,
      cwd: process.cwd(),
      autoContext: ac?.text,
      onText: (c) => r.push(c),
      onToolCall: (call) => r.status(`🔧 调用工具 ${call.name}`),
      onToolResult: (call, res) => r.status(`${res.ok ? '✓' : '✗'} ${call.name}`),
      onCompact: (info) => r.status(`⟳ 上下文已压缩 ${info.before}→${info.after} token`),
    });
    r.newline();
    void persistAutosave();
    // Phase 14：每轮结束展示本轮 + 累计成本
    console_.log(chalk.gray(`💰 ${formatSnapshot(tracker.endTurn(), tracker.snapshot())}`));
  }

  /** 规划模式的一轮：只读探测 + 产出计划，结束后进入「待批准」状态（Phase 15） */
  async function runPlan(): Promise<void> {
    const r = new StreamRenderer(chalk.green);
    tracker.beginTurn();
    // Phase 16：规划阶段同样自动注入上下文，帮助模型理解既有记忆/知识
    const ac = await autoCtxForTurn();
    if (ac && ac.text) {
      r.status(`⚡ 自动注入上下文：记忆 ${ac.memoryCount} 条 / 知识库 ${ac.ragCount} 段`);
    }
    await runAgent(history, {
      model,
      tools,
      permission,
      bus,
      compress,
      signal: abort.signal,
      cwd: process.cwd(),
      planMode: true,
      autoContext: ac?.text,
      onText: (c) => r.push(c),
      onToolCall: (call) => r.status(`🔍 规划探测 ${call.name}`),
      onToolResult: (call, res) => r.status(`${res.ok ? '✓' : '✗'} ${call.name}`),
      onBatch: (info) =>
        r.status(`⚡ 并行探测 ${info.readCount} 个只读工具（峰值并发 ${info.maxConcurrency}）`),
      onCompact: (info) => r.status(`⟳ 上下文已压缩 ${info.before}→${info.after} token`),
    });
    r.newline();
    void persistAutosave();
    console_.log(chalk.gray(`💰 ${formatSnapshot(tracker.endTurn(), tracker.snapshot())}`));
    awaitingApproval = true;
    console_.log(chalk.bold.yellow('\n⬆ 以上是模型生成的执行计划。'));
    console_.log(
      chalk.gray('   /approve 执行  ·  /discard 放弃  ·  直接输入补充让模型修订'),
        );
  }

  /** Phase 17：Multi-Agent —— 把任务拆给 Planner → 并发 Worker（各自隔离 worktree）→ Reviewer */
  async function runMultiAgentCommand(task: string): Promise<void> {
    const { runMultiAgent } = await import('../core/multiagent');
    const r = new StreamRenderer(chalk.cyan);
    console_.log(chalk.bold.cyan('\n⚙️ Multi-Agent 启动'));
    let spawns = 0;
    const res = await runMultiAgent({
      task,
      model,
      tools,
      permission,
      bus,
      compress,
      cwd: process.cwd(),
      hooks: {
        onAgentSpawn: (info) => {
          spawns++;
          console_.log(chalk.gray(`  ▸ ${info.label} 启动`));
        },
        onAgentDone: (info) =>
          console_.log(chalk.gray(`  ✓ ${info.label} 完成（${info.ok ? '成功' : '失败'}）`)),
        onText: (role, id, chunk) => {
          if (role === 'worker' && id) r.push(chunk);
        },
      },
    });
    r.newline();
    if (res.plan.subtasks.length > 0) {
      console_.log(chalk.bold('\n📋 计划'));
      console_.log(chalk.gray(`  目标：${res.plan.goal || task}`));
      for (const s of res.plan.subtasks) {
        console_.log(chalk.gray(`  · [${s.id}] ${s.title}`));
      }
    }
    console_.log(chalk.bold('\n🛠 Worker 结果（各自在隔离 worktree 中运行）'));
    for (const w of res.workers) {
      console_.log(
        chalk[w.ok ? 'green' : 'red'](`  [${w.subtask.id}] ${w.subtask.title} — ${w.ok ? '成功' : '失败'}`),
      );
      console_.log(chalk.gray(`    工作目录：${w.cwd}`));
      if (w.output.trim()) console_.log(chalk.gray(`    产出：${w.output.trim().slice(0, 400)}`));
      if (w.error) console_.log(chalk.red(`    错误：${w.error}`));
    }
    console_.log(chalk.bold('\n🔍 Reviewer 结论'));
    console_.log(res.review || '（无）');
    void spawns;
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
      case 'cost': {
        // Phase 14：详细展示本次会话的用量与成本
        const s = tracker.snapshot();
        const est = s.estimated ? chalk.yellow(' （含估算值）') : '';
        console_.log(chalk.bold('本次会话用量与成本：') + est);
        console_.log(chalk.gray(`  模型调用 : ${s.calls} 次`));
        console_.log(chalk.gray(`  Prompt   : ~${formatTokens(s.promptTokens)} token`));
        console_.log(chalk.gray(`  Completion: ~${formatTokens(s.completionTokens)} token`));
        console_.log(chalk.gray(`  合计     : ~${formatTokens(s.totalTokens)} token`));
        console_.log(chalk.gray(`  成本     : ${formatUSD(s.cost)}`));
        const extras: string[] = [];
        if (s.compressions)
          extras.push(`压缩 ${s.compressions} 次 / 省 ~${formatTokens(s.tokensSavedByCompact)} tok`);
        if (s.retrievals) extras.push(`检索 ${s.retrievals} 次`);
        if (extras.length) console_.log(chalk.gray(`  事件     : ${extras.join(' · ')}`));
        return 'continue';
      }
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
      case 'autoctx': {
        // Phase 16：开关「每轮自动注入记忆/知识库上下文」
        autoCtxEnabled = !autoCtxEnabled;
        console_.log(
          autoCtxEnabled
            ? chalk.gray('已开启自动上下文注入（每轮自动检索记忆/知识库）')
            : chalk.gray('已关闭自动上下文注入'),
        );
        return 'continue';
      }
      case 'agent': {
        // Phase 17：Multi-Agent —— 把任务拆给 Planner → 并发 Worker（隔离 worktree）→ Reviewer
        const task = rest.join(' ').trim();
        if (!task) {
          console_.log(chalk.yellow('用法: /agent <任务描述>  启动多 Agent 协作（规划+并发执行+评审）'));
          return 'continue';
        }
        await runMultiAgentCommand(task);
        return 'continue';
      }
      case 'plan': {
        // Phase 15：进入规划模式，生成执行计划待批准
        const task = rest.join(' ').trim();
        if (!task) {
          console_.log(chalk.yellow('用法: /plan <任务描述>  进入规划模式并生成执行计划'));
          return 'continue';
        }
        setMode('plan');
        planCheckpoint = history.length; // 记录规划前位置，便于 /discard 回滚
        history.push({ role: 'user', content: task });
        process.stdout.write(chalk.green('\n规划中 › '));
        awaitingApproval = false;
        await runPlan();
        return 'continue';
      }
      case 'approve': {
        // Phase 15：批准计划 → 切回正常模式并执行（同一份 history，计划即上下文）
        if (!awaitingApproval) {
          console_.log(chalk.yellow('当前没有待批准计划，请先用 /plan 生成计划。'));
          return 'continue';
        }
        setMode('normal');
        awaitingApproval = false;
        dispatch('(计划已批准，请按上述计划开始执行所需操作)');
        return 'continue';
      }
      case 'discard': {
        // Phase 15：放弃计划并回滚到规划前（含只读探测），切回正常模式
        if (!awaitingApproval) {
          console_.log(chalk.yellow('当前没有待批准计划。'));
          return 'continue';
        }
        history.length = planCheckpoint;
        setMode('normal');
        awaitingApproval = false;
        console_.log(chalk.gray('已放弃计划，回到正常模式。'));
        return 'continue';
      }
      default:
        console_.log(chalk.yellow(`未知命令: ${cmd}（输入 /help 查看可用命令）`));
        return 'continue';
    }
  }

  /** 处理一条输入：slash 走命令，普通文本入 history 并跑一轮（Phase 15：待批准时普通输入视为修订计划） */
  async function processInput(input: string): Promise<'exit' | 'continue'> {
    if (input.startsWith('/')) return handleSlash(input);
    if (awaitingApproval) {
      // 计划待批准时，普通输入 = 对计划的补充修订：保留已生成计划，重新规划
      history.push({ role: 'user', content: input });
      process.stdout.write(chalk.green('\n修订规划中 › '));
      await runPlan();
      return 'continue';
    }
    history.push({ role: 'user', content: input });
    process.stdout.write(chalk.green('\n助手 › '));
    await runTurn();
    return 'continue';
  }

  // ---- 输入处理：模型生成期间到达的输入不丢弃，排队在本轮结束后顺序处理 ----
  const pending: string[] = [];

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
        if (exited) editor.exit(); // /exit、/quit：退出（resolve startRepl）
        else editor.show(); // 回到输入态
      }
    })();
  }

  /** 记一条命令到跨会话历史（去重 + 落盘 + 同步本地历史供 ↑↓ 翻历史） */
  function recordHistory(line: string): void {
    const t = line.trim();
    if (!t) return;
    historyStore.add(t);
    if (histLines[0] !== t) {
      histLines.unshift(t);
      if (histLines.length > 2000) histLines.length = 2000;
    }
  }

  // startRepl 在 REPL 真正关闭（/exit、Ctrl+C 空闲、Ctrl+D）时才 resolve，
  // 这样 main 里的 await shutdownMcp() 会在退出时执行，正确清理 MCP 子进程等资源。
  return editor.start();
}

function printHelp(): void {
  const lines = [chalk.bold('可用命令：')];
  for (const c of COMMANDS) {
    lines.push(`  /${c.name.padEnd(10)} ${c.description}`);
  }
  lines.push(
    '',
    chalk.gray('交互提示：输入 / 弹出命令菜单，↑↓ 选择、Tab/Enter 填充 · ↑↓ 翻历史（跨会话持久）· 直接粘贴多行代码作为「一条消息」'),
    chalk.gray('模型可自主调用 read_file / write_file / edit_file / list_dir / glob / grep / bash 完成多步任务。'),
  );
  console.log(lines.join('\n'));
}
