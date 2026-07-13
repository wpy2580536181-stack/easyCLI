import chalk from 'chalk';
import type { ChatMessage, ChatModel } from '../core/chatmodel';
import { ModelRequestError } from '../core/chatmodel/errors';
import { type AppConfig, saveUserConfig, appConfigToUserConfig, maskSecret, CONFIG_PATH } from '../config';
import type { ToolRegistry } from '../core/tools/registry';
import type { PermissionManager, Decision, Resolver } from '../core/security/permission';
import type { EventBus } from '../core/events/bus';
import { compressHistory, createDefaultSummarizer, type CompressOptions, estimateHistoryTokens } from '../core/memory/compressor';
import { MemoryStore } from '../core/memory/store';
import { RagStore } from '../core/rag/store';
import { buildAutoContext, lastUserText, type AutoContextResult } from '../core/context';
import { extractMemories } from '../core/memory/extractor';
import { SkillLoader } from '../core/skill';
import { SessionStore, extractConversation, withSystem, AUTOSAVE_NAME } from '../core/session/store';
import { runAgent } from '../core/agent';
import { buildAgentSystemPrompt, buildPlanSystemPrompt, type AgentMode } from '../core/prompts';
import { formatSnapshot, formatTokens, formatUSD, type CostTracker } from '../core/observability';
import { renderMarkdown } from './markdown';
import { gatherContext } from '../core/prompts/context';
import { HistoryStore } from './history';
import { COMMANDS } from './commands';
import { printSplash, renderSplash } from './splash';
import { ui } from './theme';
import { createInkView, createPlainView, type ReplView, type StatusPatch } from './repl-view';

/**
 * 构造 HITL 审批器：交互式询问用户是否放行（y/n/a），a 表示持久预批准。
 * 安全增强：
 *  - 操作预览摘要：把将要执行的完整命令（bash）或目标路径（文件工具）单独成行高亮，
 *    让用户看清再确认（对照「生产级」要求）；
 *  - 200ms 防抖：确认框刚渲染时忽略首回车，避免上一动作的残留/自动重复回车瞬间放行。
 *
 * 与旧版差异：不再依赖 LineEditor.ask（raw mode），改为 view.ask——
 * TTY 走 store.requestApproval（<Approval> 覆盖层），非 TTY 走 readline.question。
 */
function makeResolver(view: ReplView, permission: PermissionManager): Resolver {
  const HITL_DEBOUNCE_MS = 200;
  return (tool: string, detail: string): Promise<Decision> => {
    const preview = detail ? '\n' + chalk.yellow('  › ' + detail) : '';
    const question =
      chalk.yellow(`⚠ 允许执行 ${tool}?`) +
      preview +
      chalk.gray('  [y=允许 / n=拒绝 / a=总是允许] ');
    return view.ask(question, { debounceMs: HITL_DEBOUNCE_MS }).then((ans) => {
      const a = ans.trim().toLowerCase();
      if (a === 'a' || a === 'always') {
        permission.addAllow(tool);
        return 'allow' as Decision;
      }
      if (a === 'y' || a === 'yes') return 'allow' as Decision;
      return 'deny' as Decision;
    });
  };
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
  autoMemory?: boolean,
  semanticRecall?: boolean,
  autoInjectNames?: string[],
): Promise<void> {
  // runOnce 是一次性非交互调用：始终用纯文本 StreamRenderer 后端，让回复留在滚动区
  // （Ink 挂屏会在退出时清掉回复，反而丢失输出）。非 TTY 亦然。
  const view = createPlainView({
    prompt: ui.prompt,
    history: [],
    onSubmit: () => 'continue',
    onInterrupt: () => {},
    onExit: () => {},
  });

  // 前缀缓存命中率：从 token 事件回填到状态栏（让优化「肉眼可见」）。非 TTY 无状态栏，忽略。
  bus?.on('token', (e) => {
    const u = e as { cacheReadTokens?: number; promptTokens?: number };
    if (u.cacheReadTokens != null && (u.promptTokens ?? 0) > 0) {
      view.setCache(Math.round((u.cacheReadTokens / u.promptTokens!) * 100));
    }
  });

  // ⚠ 前缀缓存：sysCtx 在本函数内只构造一次 → now 被冻结在「会话起点」。
  // 这样含时间/cwd/git 的 system 提示在整段会话里逐字节稳定（前缀匹配才能命中）。
  const sysCtx = {
    cwd: process.cwd(),
    skillsMenu:
      autoInjectNames && autoInjectNames.length
        ? skillLoader?.menuTextExcluding(autoInjectNames) ?? undefined
        : skillLoader?.menuText() ?? undefined,
    toolNames: tools.list().map((t) => t.name),
    now: new Date(),
  };
  // Phase 22：Skill 自动注入——把指定技能正文拼入稳定 system 前缀（不被压缩、缓存友好）。
  const autoInjectBlock =
    autoInjectNames && autoInjectNames.length ? skillLoader?.autoInjectBlock(autoInjectNames) ?? '' : '';
  const baseSys = planMode ? buildPlanSystemPrompt(sysCtx) : buildAgentSystemPrompt(sysCtx);
  const sys = autoInjectBlock ? `${baseSys}\n\n${autoInjectBlock}` : baseSys;
  const history: ChatMessage[] = [
    { role: 'system', content: sys },
    { role: 'user', content: prompt },
  ];
  // 单次模式没有欢迎面板/历史，但本轮用户输入（提示符 + prompt）仍作为 userTurn 渲染，
  // 与 REPL 模式保持一致；规划模式额外把提示行作为 header 顶部。
  if (planMode) view.printLine(chalk.bold.yellow('（规划模式：仅生成计划，不执行）'));
  view.beginUserTurn(prompt);
  // Phase 16：单次模式也自动注入上下文（基于 prompt 检索记忆/知识库）
  const semanticRecallEnabled = semanticRecall ?? true;
  let autoContext: string | undefined;
  if (autoContextEnabled ?? false) {
    const ac = await buildAutoContext(prompt, {
      memory,
      ragStore,
      model: semanticRecallEnabled ? model : null,
    });
    if (ac.text) autoContext = ac.text;
  }
  // 非交互模式无 HITL 提示：默认只读工具放行，写/危险操作被拒（安全默认）
  view.begin('思考中…');
  try {
    await runAgent(history, {
      model,
      tools,
      permission,
      bus,
      compress,
      cwd: process.cwd(),
      planMode,
      autoContext,
      onText: (c) => view.pushToken(c),
      onToolCall: (call) => view.toolStart(call.name),
      onToolResult: (call, res) => view.toolDone(call.name, res.ok),
    });
  } finally {
    view.finishTurn();
  }
  // Phase 14：打印本次会话总成本（单次模式，单轮即累计）
  const costLine = chalk.gray(`💰 ${formatSnapshot(tracker.endTurn(), tracker.snapshot())}`);
  view.exit();
  console.log(costLine);
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
  autoMemory?: boolean,
  semanticRecall?: boolean,
  autoInjectNames?: string[],
  /** 已连接 MCP server 总数（注入 splash 信息框，避免 main.ts 额外装配） */
  mcpCount?: number,
): Promise<void> {
  // 启动欢迎面板（Splash）：TTY 下只渲染进 Ink 的 initialTranscript（由 Transcript 组件画一次，
  // 不 console.log，否则会与 Ink 渲染的 splash 重复成两个框）；非 TTY 纯文本直接打印，无需常驻
  // transcript（没有状态栏重绘）。无 API Key 时 TTY 也给出首屏前提示。
  if (!config.llm.apiKey) {
    console.log(chalk.yellow('⚠ 未检测到 API Key，请设置 AGENTCLI_API_KEY（或 OPENAI_API_KEY）后再对话。'));
  }

  const statusBarEnabled = config.statusline !== false;
  const branch = gatherContext(process.cwd()).gitBranch ?? '(无)';
  const historyStore = new HistoryStore();
  // 本地维护一份「新 → 旧」历史，用于 Tab 补全与跨会话 ↑/↓。
  const histLines: string[] = historyStore.forReadline();
  const promptStr = ui.prompt;

  // 规划模式（Phase 15）需要「切换系统提示」：把正常/规划两套系统提示都准备好，
  // 进入/退出规划模式时只替换 history[0].content，不另起引擎。
  // ⚠ 前缀缓存：sysCtx 在会话内只构造一次 → now 冻结在会话起点，
  // 使含时间/cwd/git 的 system 提示整段稳定（前缀匹配才能命中）。
  const sysCtx = {
    cwd: process.cwd(),
    skillsMenu:
      autoInjectNames && autoInjectNames.length
        ? skillLoader?.menuTextExcluding(autoInjectNames) ?? undefined
        : skillLoader?.menuText() ?? undefined,
    toolNames: tools.list().map((t) => t.name),
    now: new Date(),
  };
  // Phase 22：Skill 自动注入块——构造一次、会话内稳定，作为 system 前缀的一部分（缓存友好、不被压缩）。
  const autoInjectBlock =
    autoInjectNames && autoInjectNames.length ? skillLoader?.autoInjectBlock(autoInjectNames) ?? '' : '';
  /** 按模式构造系统提示：基础提示 + 自动注入块（若开启）。normal/plan 共用，保证切换一致。 */
  function makeSys(m: AgentMode): string {
    const base = m === 'plan' ? buildPlanSystemPrompt(sysCtx) : buildAgentSystemPrompt(sysCtx);
    return autoInjectBlock ? `${base}\n\n${autoInjectBlock}` : base;
  }
  const history: ChatMessage[] = [{ role: 'system', content: makeSys('normal') }];
  // 模式与批准状态（Phase 15）
  let mode: AgentMode = 'normal';
  let normalSys = makeSys('normal');
  let awaitingApproval = false;
  let planCheckpoint = 0;
  // Phase 16：自动上下文注入开关（默认关；可用 /autoctx 切换，或 --auto-context 开启）
  let autoCtxEnabled = autoContextEnabled ?? false;
  // Phase 20：自动记忆增强开关（默认开；可从 config/CLI 关闭）
  const autoMemoryEnabled = autoMemory ?? true;
  const semanticRecallEnabled = semanticRecall ?? true;

  /** 切换运行模式：替换 system 消息内容（normal <-> plan），其余 history 不动 */
  function setMode(m: AgentMode): void {
    mode = m;
    const content = makeSys(m);
    if (history[0] && typeof history[0].content === 'string') history[0].content = content;
    view.setStatus({ mode });
  }

  // Phase 9：会话存储 + 跨会话恢复。每轮结束自动写 autosave，--resume 时恢复。
  const sessionStore = new SessionStore();
  if (resume && sessionStore.exists(AUTOSAVE_NAME)) {
    const loaded = sessionStore.load(AUTOSAVE_NAME);
    if (loaded) {
      const systemContent = typeof history[0]?.content === 'string' ? history[0].content : '';
      history.length = 0;
      history.push(...withSystem(loaded, systemContent));
      // 恢复后重建 normalSys（含 Phase 22 自动注入块），保证 /plan→/discard 切换时 system 一致
      normalSys = makeSys('normal');
      if (typeof history[0]?.content === 'string') history[0].content = normalSys;
      console.log(chalk.gray(`⟳ 已从自动保存的会话恢复（${loaded.length} 条消息）`));
    }
  }

  const abort = new AbortController();
  let busy = false;
  const pending: string[] = [];

  // —— 渲染后端（ReplView）：TTY 走 Ink，非 TTY 走 readline + StreamRenderer ——
  let view: ReplView;

  const onInterrupt = (): void => {
    if (busy) abort.abort();
    else view.exit();
  };
  const onExit = (): void => view.exit();
  const onSubmit = (line: string): Promise<'exit' | 'continue'> => {
    recordHistory(line);
    return dispatch(line);
  };

  const tty = !!(process.stdout.isTTY && process.stdin.isTTY);
  // 非 TTY 纯文本：直接打印 splash 首屏（无状态栏重绘需求，无需常驻 transcript）。
  if (!tty) printSplash({ modelId: model.id });
  view = tty
    ? createInkView({
        model: model.id,
        branch,
        mode: 'normal',
        statuslineEnabled: statusBarEnabled,
        commands: COMMANDS,
        prompt: promptStr,
        history: histLines,
        markdown: renderMarkdown,
        onSubmit,
        onInterrupt,
        initialHistory: [],
        // TTY：仅把 splash 行交给 Ink 渲染一次（renderSplash 不 console.log，避免双重框）。
        initialTranscript: renderSplash({
          modelId: model.id,
          toolCount: tools.list().length,
          skillCount: skillLoader?.list().length ?? 0,
          mcpCount: mcpCount ?? 0,
        }),
      })
    : createPlainView({ prompt: promptStr, history: histLines, onSubmit, onInterrupt, onExit });

  // 前缀缓存命中率：从 token 事件回填到状态栏（让优化「肉眼可见」）
  bus?.on('token', (e) => {
    const u = e as { cacheReadTokens?: number; promptTokens?: number };
    if (u.cacheReadTokens != null && (u.promptTokens ?? 0) > 0) {
      view.setCache(Math.round((u.cacheReadTokens / u.promptTokens!) * 100));
    }
  });

  // 把交互式 HITL 提示器注入权限管理器，执行器在 ask 决策时回调它
  permission.setResolver(makeResolver(view, permission));

  /** Phase 16：根据最新用户输入，自动检索记忆/知识库拼出本轮要注入的上下文 */
  async function autoCtxForTurn(): Promise<AutoContextResult | undefined> {
    if (!autoCtxEnabled) return undefined;
    const q = lastUserText(history);
    if (!q) return undefined;
    const res = await buildAutoContext(q, {
      memory,
      ragStore,
      model: semanticRecallEnabled ? model : null,
    });
    return res.text ? res : undefined;
  }

  /** 同步状态栏：刷新成本 / 上下文占用率 / 模式（每轮结束、回到输入态时调用） */
  function refreshStatus(extra: StatusPatch = {}): void {
    const cum = tracker.snapshot();
    const tokenText = '~' + formatTokens(cum.totalTokens) + ' tok';
    const ctxPct = compress
      ? Math.round((estimateHistoryTokens(history, compress.counter) / compress.budgetTokens) * 100)
      : undefined;
    view.setStatus({ tokenText, ctxPct, mode, ...extra });
  }

  /** 把模型调用抛出的错误翻译成「对用户友好的一行提示」。返回空串表示无需提示（如用户主动 Ctrl+C 中断）。 */
  function modelErrorNote(e: unknown): string {
    if (e instanceof ModelRequestError) {
      if (e.kind === 'abort') return ''; // 中断不提示
      if (e.kind === 'network') return `🌐 ${e.message}`;
      if (e.kind === 'http') return `⚠️ 模型服务返回错误：${e.message}`;
      return `⚠️ ${e.message}`;
    }
    const msg = e instanceof Error ? e.message : String(e);
    return `⚠️ 发生未知错误：${msg}`;
  }

  // 某轮模型调用失败的兜底展示：把友好提示写进 transcript（TTY 永久行 / 非 TTY 直印），
  // 然后正常返回（不抛出），从而不会冒泡成「未处理异常」冲垮整个 REPL 进程。
  function showTurnError(e: unknown): void {
    const note = modelErrorNote(e);
    if (!note) return;
    view.printLine(chalk.gray(note));
  }

  /** Phase 9：每轮结束把当前对话（不含 system）压缩后写入 autosave，供 --resume 恢复。失败静默忽略。 */
  async function persistAutosave(): Promise<void> {
    try {
      await sessionStore.save(AUTOSAVE_NAME, extractConversation(history), compress);
    } catch {
      /* 自动保存失败静默忽略 */
    }
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

  async function runTurn(input: string): Promise<void> {
    let turnError = false;
    // Phase 20：本轮是否显式调过 remember（用于自动提取的来源门控，避免重复）
    let turnUsedRemember = false;
    // 把「提示符 + 输入」输入框行交给视图（TTY 带底色、进入思考态并隐藏输入框），
    // 旧 status.setUserTurn + status.begin 的等价替代。
    view.beginUserTurn(input);
    tracker.beginTurn();
    const ac = await autoCtxForTurn();
    view.begin('思考中…');
    // 生成期间隐藏上下文占用率（避免与动画行的 ↓ N tokens 重复）
    view.setStatus({ showCtx: false });
    if (ac && ac.text) {
      view.setAnimLabel(`⚡ 自动注入上下文：记忆 ${ac.memoryCount} 条 / 知识库 ${ac.ragCount} 段`);
    }
    try {
      await runAgent(history, {
        model,
        tools,
        permission,
        bus,
        compress,
        signal: abort.signal,
        cwd: process.cwd(),
        autoContext: ac?.text,
        onText: (c) => view.pushToken(c),
        onToolCall: (call) => {
          if (call.name === 'remember') turnUsedRemember = true;
          view.toolStart(call.name);
        },
        onToolResult: (call, res) => view.toolDone(call.name, res.ok),
        onCompact: (info) => view.setAnimLabel(`⟳ 上下文已压缩 ${info.before}→${info.after} token`),
      });
    } catch (e) {
      // 模型调用失败（多为网络/密钥问题）：友好提示后正常返回，不冲垮 REPL。
      turnError = true;
      showTurnError(e);
    }
    try {
      if (!turnError) {
        void persistAutosave();
        // Phase 20：自动记忆提取——本轮若未显式 remember，则从对话被动提取稳定事实写入记忆库。
        // fire-and-forget：不阻塞、失败静默，与 persistAutosave 同一约定。
        if (autoMemoryEnabled && memory && !turnUsedRemember) {
          void extractMemories(history, { model, store: memory })
            .then((n) => {
              if (n > 0) view.printLine(chalk.gray(`🧠 已自动记住 ${n} 条事实`));
            })
            .catch(() => {
              /* 静默 */
            });
        }
        // Phase 14：每轮结束展示本轮 + 累计成本（并入 transcript，下一轮可见）
        const costLine = chalk.gray(`💰 ${formatSnapshot(tracker.endTurn(), tracker.snapshot())}`);
        // 正文渲染：TTY 经 renderMarkdown 把 assistantBuffer 渲染成 ANSI 行；
        // 非 TTY 正文已流式输出，此处仅取 extra（成本行）。
        const bodyLines = view.flushAndRenderBody();
        view.commitDisplay(bodyLines, [costLine]);
      }
    } finally {
      // 无论正常结束还是被 Ctrl+C 中断，都清掉缓冲、回到输入态（TTY）/ 补换行（非 TTY）。
      view.finishTurn();
      refreshStatus({ showCtx: true });
    }
  }

  /** 规划模式的一轮：只读探测 + 产出计划，结束后进入「待批准」状态（Phase 15） */
  async function runPlan(input: string): Promise<void> {
    let turnError = false;
    let turnUsedRemember = false;
    view.beginUserTurn(input);
    tracker.beginTurn();
    const ac = await autoCtxForTurn();
    view.begin('规划中…');
    if (ac && ac.text) {
      view.setAnimLabel(`⚡ 自动注入上下文：记忆 ${ac.memoryCount} 条 / 知识库 ${ac.ragCount} 段`);
    }
    try {
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
        onText: (c) => view.pushToken(c),
        onToolCall: (call) => {
          if (call.name === 'remember') turnUsedRemember = true;
          view.setAnimLabel(`🔍 规划探测 ${call.name}`);
        },
        onToolResult: (call, res) => view.setAnimLabel(`${res.ok ? '✓' : '✗'} ${call.name}`),
        onBatch: (info) =>
          view.setAnimLabel(`⚡ 并行探测 ${info.readCount} 个只读工具（峰值并发 ${info.maxConcurrency}）`),
        onCompact: (info) => view.setAnimLabel(`⟳ 上下文已压缩 ${info.before}→${info.after} token`),
      });
    } catch (e) {
      turnError = true;
      showTurnError(e);
    }
    try {
      if (!turnError) {
        void persistAutosave();
        if (autoMemoryEnabled && memory && !turnUsedRemember) {
          void extractMemories(history, { model, store: memory })
            .then((n) => {
              if (n > 0) view.printLine(chalk.gray(`🧠 已自动记住 ${n} 条事实`));
            })
            .catch(() => {
              /* 静默 */
            });
        }
        const costLine = chalk.gray(`💰 ${formatSnapshot(tracker.endTurn(), tracker.snapshot())}`);
        // 计划批注（空行 + 提示）并入 transcript，下一轮可见
        const notes = [
          '',
          chalk.bold.yellow('⬆ 以上是模型生成的执行计划。'),
          chalk.gray('   /approve 执行  ·  /discard 放弃  ·  直接输入补充让模型修订'),
        ];
        const bodyLines = view.flushAndRenderBody();
        view.commitDisplay(bodyLines, [costLine, ...notes]);
      }
    } finally {
      view.finishTurn();
      refreshStatus({ showCtx: true });
    }
    awaitingApproval = true;
  }

  /** Phase 17：Multi-Agent —— 把任务拆给 Planner → 并发 Worker（各自隔离 worktree）→ Reviewer */
  async function runMultiAgentCommand(task: string): Promise<void> {
    const { runMultiAgent } = await import('../core/multiagent');
    // worker 流式输出按行喂给 transcript（TTY 永久行 / 非 TTY 直印），避免半行污染。
    let streamBuf = '';
    const pushStream = (chunk: string): void => {
      streamBuf += chunk;
      let idx: number;
      while ((idx = streamBuf.indexOf('\n')) >= 0) {
        const line = streamBuf.slice(0, idx);
        streamBuf = streamBuf.slice(idx + 1);
        view.printLine(line);
      }
    };
    view.printLine(chalk.bold.cyan('\n⚙️ Multi-Agent 启动'));
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
          view.printLine(chalk.gray(`  ▸ ${info.label} 启动`));
        },
        onAgentDone: (info) => view.printLine(chalk.gray(`  ✓ ${info.label} 完成（${info.ok ? '成功' : '失败'}）`)),
        onText: (role, id, chunk) => {
          if (role === 'worker' && id) pushStream(chunk);
        },
      },
    });
    if (streamBuf) view.printLine(streamBuf);
    if (res.plan.subtasks.length > 0) {
      view.printLine(chalk.bold('\n📋 计划'));
      view.printLine(chalk.gray(`  目标：${res.plan.goal || task}`));
      for (const s of res.plan.subtasks) view.printLine(chalk.gray(`  · [${s.id}] ${s.title}`));
    }
    view.printLine(chalk.bold('\n🛠 Worker 结果（各自在隔离 worktree 中运行）'));
    for (const w of res.workers) {
      view.printLine(chalk[w.ok ? 'green' : 'red'](`  [${w.subtask.id}] ${w.subtask.title} — ${w.ok ? '成功' : '失败'}`));
      view.printLine(chalk.gray(`    工作目录：${w.cwd}`));
      if (w.output.trim()) view.printLine(chalk.gray(`    产出：${w.output.trim().slice(0, 400)}`));
      if (w.error) view.printLine(chalk.red(`    错误：${w.error}`));
    }
    view.printLine(chalk.bold('\n🔍 Reviewer 结论'));
    view.printLine(res.review || '（无）');
    void spawns;
  }

  async function handleSlash(cmd: string): Promise<'exit' | 'continue'> {
    // 命令本身作为一条永久行写进 transcript（TTY 带输入框底色；非 TTY 直印），
    // 旧 slashBuffer 收集后整屏重绘的等价替代（Ink 下输出直接进 transcript，无需手工清屏）。
    view.echoInput(cmd);
    const [name, ...rest] = cmd.slice(1).split(/\s+/);
    switch (name) {
      case 'exit':
      case 'quit':
        return 'exit';
      case 'clear':
        history.length = 1;
        view.printLine(chalk.gray('上下文已清空。'));
        return 'continue';
      case 'model':
        view.printLine(chalk.gray(`当前模型: ${model.id}`));
        return 'continue';
      case 'tools':
        view.printLine(chalk.gray(`已注册工具: ${tools.list().map((t) => t.name).join(', ')}`));
        return 'continue';
      case 'cost': {
        // Phase 14：详细展示本次会话的用量与成本
        const s = tracker.snapshot();
        const est = s.estimated ? chalk.yellow(' （含估算值）') : '';
        view.printLine(chalk.bold('本次会话用量与成本：') + est);
        view.printLine(chalk.gray(`  模型调用 : ${s.calls} 次`));
        view.printLine(chalk.gray(`  Prompt   : ~${formatTokens(s.promptTokens)} token`));
        view.printLine(chalk.gray(`  Completion: ~${formatTokens(s.completionTokens)} token`));
        view.printLine(chalk.gray(`  合计     : ~${formatTokens(s.totalTokens)} token`));
        view.printLine(chalk.gray(`  成本     : ${formatUSD(s.cost)}`));
        const extras: string[] = [];
        if (s.compressions) extras.push(`压缩 ${s.compressions} 次 / 省 ~${formatTokens(s.tokensSavedByCompact)} tok`);
        if (s.retrievals) extras.push(`检索 ${s.retrievals} 次`);
        if (extras.length) view.printLine(chalk.gray(`  事件     : ${extras.join(' · ')}`));
        return 'continue';
      }
      case 'compact': {
        const before = estimateHistoryTokens(history, compress?.counter);
        view.printLine(chalk.gray(`上下文 ${before} token，开始压缩…`));
        const summarizer = createDefaultSummarizer(model);
        const base: CompressOptions = compress ?? {
          budgetTokens: 8000,
          keepRecentTurns: 4,
          maxToolOutputChars: 1500,
        };
        const compressed = await compressHistory(history, {
          ...base,
          summarizer,
          counter: base.counter ?? compress?.counter,
          atTurnBoundary: true,
        });
        const after = estimateHistoryTokens(compressed, compress?.counter);
        history.length = 0;
        history.push(...compressed);
        view.printLine(chalk.gray(`压缩完成：${before} → ${after} token（省 ~${formatTokens(before - after)} token）`));
        return 'continue';
      }
      case 'perm':
        view.printLine(chalk.gray(`允许: ${permission.getAllow().join(', ') || '(空)'}`));
        view.printLine(chalk.gray(`拒绝: ${permission.getDeny().join(', ') || '(空)'}`));
        return 'continue';
      case 'config': {
        const [sub] = rest;
        if (sub === 'save') {
          saveUserConfig(appConfigToUserConfig(config));
          view.printLine(chalk.gray(`已写入 ${CONFIG_PATH}`));
        } else {
          const mcp = config.mcpServers;
          const rag = config.ragPath
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
          view.printLine(chalk.bold('当前配置（生效值）：'));
          view.printLine(chalk.gray(`  provider : ${config.provider}`));
          view.printLine(chalk.gray(`  model    : ${config.llm.model}`));
          view.printLine(chalk.gray(`  baseURL  : ${config.llm.baseURL}`));
          view.printLine(chalk.gray(`  apiKey   : ${maskSecret(config.llm.apiKey)}`));
          view.printLine(chalk.gray(`  MCP 源   : ${mcp.length} 个`));
          view.printLine(chalk.gray(`  RAG 源   : ${rag.length ? rag.join(', ') : '(空)'}`));
          view.printLine(chalk.gray('（/config save 可持久化当前配置）'));
        }
        return 'continue';
      }
      case 'rag': {
        if (!ragStore) {
          view.printLine(chalk.yellow('未启用 RAG：启动时请用 --rag <路径> 或设置 AGENTCLI_RAG_PATH'));
          return 'continue';
        }
        const [sub, ...rest2] = rest;
        const arg = rest2.join(' ').trim();
        if (sub === 'search' && arg) {
          const r = await ragStore.search(arg, 5);
          view.printLine(RagStore.toContext(r));
        } else if (sub === 'ingest' && arg) {
          const { docs, chunks } = await ragStore.addSource(arg);
          view.printLine(chalk.gray(`已增量索引 ${arg}：共 ${docs} 文档 / ${chunks} 片段`));
        } else if (sub === 'reindex') {
          const { docs, chunks } = await ragStore.reindex();
          view.printLine(chalk.gray(`已重建索引：${docs} 文档 / ${chunks} 片段`));
        } else if (sub === 'status') {
          const s = ragStore.status();
          view.printLine(chalk.gray(`RAG 状态：文档 ${s.docs} / 片段 ${s.chunks} / 维度 ${s.dim}`));
          view.printLine(chalk.gray(`来源: ${ragStore.getSources().join(', ') || '(空)'}`));
        } else {
          view.printLine(chalk.yellow('用法: /rag <search|ingest|reindex|status> [参数]'));
        }
        return 'continue';
      }
      case 'skills': {
        const list = skillLoader?.list() ?? [];
        if (list.length === 0) {
          view.printLine(chalk.gray('（当前无已加载技能）'));
        } else {
          for (const s of list) {
            view.printLine(chalk.gray(`- ${s.name} [${s.layer}]：${s.description}`));
          }
        }
        return 'continue';
      }
      case 'skill': {
        const name = rest.join(' ').trim();
        if (!name) {
          view.printLine(chalk.yellow('用法: /skill <技能名>'));
          return 'continue';
        }
        const skill = skillLoader?.load(name);
        if (!skill) {
          view.printLine(chalk.yellow(`未找到技能: ${name}`));
        } else {
          view.printLine(chalk.bold(`技能：${skill.name}`) + chalk.gray(`（来源 ${skill.layer}）`));
          view.printLine(skill.body.trim());
        }
        return 'continue';
      }
      case 'save': {
        const sname = rest[0]?.trim() || 'default';
        await sessionStore.save(sname, extractConversation(history), compress);
        view.printLine(chalk.gray(`已保存会话「${sname}」（${history.length - 1} 条消息）`));
        return 'continue';
      }
      case 'load': {
        const sname = rest[0]?.trim() || 'default';
        const loaded = sessionStore.load(sname);
        if (!loaded) {
          view.printLine(chalk.yellow(`未找到会话: ${sname}`));
          return 'continue';
        }
        const systemContent = typeof history[0]?.content === 'string' ? history[0].content : '';
        history.length = 0;
        history.push(...withSystem(loaded, systemContent));
        view.printLine(chalk.gray(`已载入会话「${sname}」（${loaded.length} 条消息）`));
        return 'continue';
      }
      case 'sessions': {
        const list = sessionStore.list();
        if (list.length === 0) {
          view.printLine(chalk.gray('（当前无已保存会话）'));
        } else {
          for (const s of list) {
            view.printLine(
              chalk.gray(`- ${s.name} ：${s.messageCount} 条消息，更新于 ${new Date(s.updatedAt).toLocaleString()}`),
            );
          }
        }
        return 'continue';
      }
      case 'session': {
        const sname = rest[0]?.trim();
        if (!sname) {
          view.printLine(chalk.yellow('用法: /session <会话名>'));
          return 'continue';
        }
        const loaded = sessionStore.load(sname);
        if (!loaded) {
          view.printLine(chalk.yellow(`未找到会话: ${sname}`));
          return 'continue';
        }
        view.printLine(chalk.bold(`会话「${sname}」（${loaded.length} 条）预览：`));
        for (const m of loaded) {
          const full =
            typeof m.content === 'string'
              ? m.content
              : m.content.map((b) => (b.type === 'text' ? b.text : `[${b.type}]`)).join('');
          const preview = full.slice(0, 200);
          view.printLine(chalk.gray(`  [${m.role}] ${preview}${full.length > 200 ? '…' : ''}`));
        }
        return 'continue';
      }
      case 'rm': {
        const sname = rest[0]?.trim();
        if (!sname) {
          view.printLine(chalk.yellow('用法: /rm <会话名>'));
          return 'continue';
        }
        const ok = sessionStore.remove(sname);
        view.printLine(ok ? chalk.gray(`已删除会话「${sname}」`) : chalk.yellow(`未找到会话: ${sname}`));
        return 'continue';
      }
      case 'help':
        printHelp((l) => view.printLine(l));
        return 'continue';
      case 'prompt': {
        const text = rest.join(' ').trim();
        if (text) {
          history.push({ role: 'user', content: text });
          await runTurn(text);
        } else {
          view.printLine(chalk.yellow('用法: /prompt <你的问题>'));
        }
        return 'continue';
      }
      case 'autoctx': {
        // Phase 16：开关「每轮自动注入记忆/知识库上下文」
        autoCtxEnabled = !autoCtxEnabled;
        view.printLine(
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
          view.printLine(chalk.yellow('用法: /agent <任务描述>  启动多 Agent 协作（规划+并发执行+评审）'));
          return 'continue';
        }
        await runMultiAgentCommand(task);
        return 'continue';
      }
      case 'plan': {
        // Phase 15：进入规划模式，生成执行计划待批准
        const task = rest.join(' ').trim();
        if (!task) {
          view.printLine(chalk.yellow('用法: /plan <任务描述>  进入规划模式并生成执行计划'));
          return 'continue';
        }
        setMode('plan');
        planCheckpoint = history.length; // 记录规划前位置，便于 /discard 回滚
        history.push({ role: 'user', content: task });
        view.printLine(ui.muted('⚙ 规划中…'));
        awaitingApproval = false;
        await runPlan(task);
        return 'continue';
      }
      case 'approve': {
        // Phase 15：批准计划 → 切回正常模式并执行（同一份 history，计划即上下文）
        if (!awaitingApproval) {
          view.printLine(chalk.yellow('当前没有待批准计划，请先用 /plan 生成计划。'));
          return 'continue';
        }
        setMode('normal');
        awaitingApproval = false;
        await dispatch('(计划已批准，请按上述计划开始执行所需操作)');
        return 'continue';
      }
      case 'discard': {
        // Phase 15：放弃计划并回滚到规划前（含只读探测），切回正常模式
        if (!awaitingApproval) {
          view.printLine(chalk.yellow('当前没有待批准计划。'));
          return 'continue';
        }
        history.length = planCheckpoint;
        setMode('normal');
        awaitingApproval = false;
        view.printLine(chalk.gray('已放弃计划，回到正常模式。'));
        return 'continue';
      }
      default:
        view.printLine(chalk.yellow(`未知命令: ${cmd}（输入 /help 查看可用命令）`));
        return 'continue';
    }
  }

  /** 处理一条输入：slash 走命令，普通文本入 history 并跑一轮（Phase 15：待批准时普通输入视为修订计划） */
  function isPinnedInput(text: string): boolean {
    return /(记住|记一下|重要|务必|别忘|删?除?这?条|置顶|保留这)/i.test(text);
  }

  async function processInput(input: string): Promise<'exit' | 'continue'> {
    if (input.startsWith('/')) {
      return await handleSlash(input);
    }
    if (awaitingApproval) {
      // 计划待批准时，普通输入 = 对计划的补充修订：保留已生成计划，重新规划
      history.push({ role: 'user', content: input, ...(isPinnedInput(input) ? { protected: true } : {}) });
      view.printLine(ui.muted('⚙ 修订规划中…'));
      await runPlan(input);
      return 'continue';
    }
    history.push({ role: 'user', content: input, ...(isPinnedInput(input) ? { protected: true } : {}) });
    await runTurn(input);
    return 'continue';
  }

  // ---- 输入处理：总线入口（TTY 由 <InputBox> 的 onSubmit 触发；非 TTY 由 readline 循环触发）----
  async function dispatch(input: string): Promise<'exit' | 'continue'> {
    if (busy) {
      // Ink 模式输入框在忙时被隐藏，不会收到输入；非 TTY readline 也只在 dispatch 完成后
      // 才显示下一提示，所以此处实际不会被触发。保留防御性排队以兼容极端时序。
      pending.push(input);
      return 'continue';
    }
    busy = true;
    let exited = false;
    try {
      exited = (await processInput(input)) === 'exit';
      // 排空排队输入（退出则停止）
      while (!exited && pending.length) {
        const next = pending.shift()!;
        exited = (await processInput(next)) === 'exit';
      }
    } catch (e) {
      // 最后防线：理论上 runTurn/runPlan 已就地消化模型错误，这里兜底任何意外异常，
      // 打印一行友好提示后回到输入态，绝不把整个 REPL 进程打崩。
      const msg = e instanceof Error ? e.message : String(e);
      view.printLine(chalk.red(`⚠️ 处理输入时出错：${msg}`));
    } finally {
      busy = false;
      refreshStatus({ showCtx: true }); // 一轮结束：刷新成本/ctx/模式，恢复显示 ctx%
    }
    if (exited) view.exit(); // /exit、/quit：退出（resolve startRepl / 关闭 readline）
    return exited ? 'exit' : 'continue';
  }

  // startRepl 在 REPL 真正关闭（/exit、Ctrl+C 空闲、Ctrl+D）时才 resolve，
  // 这样 main 里的 await shutdownMcp() 会在退出时执行，正确清理 MCP 子进程等资源。
  try {
    refreshStatus(); // 首屏填充 ctx% / 成本 / 模式
    await view.start();
  } finally {
    // 退出时无需显式释放：Ink 已由 view.exit() unmount；readline 由 start() 的 finally 关闭。
  }
}

function printHelp(print: (line: string) => void): void {
  print(chalk.bold('可用命令：'));
  for (const c of COMMANDS) {
    print(`  /${c.name.padEnd(10)} ${c.description}`);
  }
  print('');
  print(chalk.gray('交互提示：输入 / 弹出命令菜单，↑↓ 选择、Tab/Enter 填充 · ↑↓ 翻历史（跨会话持久）· 直接粘贴多行代码作为「一条消息」'));
  print(chalk.gray('模型可自主调用 read_file / write_file / edit_file / list_dir / glob / grep / bash 完成多步任务。'));
}
