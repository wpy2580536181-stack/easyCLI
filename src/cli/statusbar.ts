import chalk from 'chalk';
import type { OutputSink } from './renderer';
import { ui } from './theme';

/**
 * 终端「状态栏」（statusline）：常驻在屏幕**最底一行**的信息条，仿 Claude Code。
 *
 * 显示字段（用 `·` 分隔，避免 emoji 堆叠带来的终端兼容问题）：
 *   `模型 · 分支 · [ctx%] · ¥成本 · 时长 · 模式`
 *   - 模型：青色突出（来自 config.llm.model）
 *   - 分支：灰色（来自 git 分支）
 *   - ctx%：上下文占用率（仅空闲时显示；生成期间为免与动画行的 ↓ N tokens 重复而隐藏；≥80% 转琥珀）
 *   - ¥成本：绿色（来自 CostTracker 累计花费）
 *   - 时长：mm:ss 会话时长（每秒刷新）
 *   - 模式：正常(绿) / 规划(琥珀)
 *
 * 与输入框盒子 / 生成动画的共存（关键，避免重蹈 StatusLine 覆写事故）：
 *   - StatusBar 始终用绝对定位 `ESC[rows;1H` 写最底行，与上方内容彻底解耦。
 *   - 重绘后用 `setCaret` 维护的光标位置显式移回活动区域（输入框/动画行），
 *     不依赖 ESC[s/u 保存/恢复序列（部分终端会忽略该序列，导致光标落到状态栏）。
 *   - 输入框盒子（line-editor）与生成动画（status）也都用绝对定位把自己锚定在
 *     `rows-1` 及上方，天然把最底行留给本状态栏，无需设置滚动区（设置滚动区反而
 *     会让依赖 \n 前进的输入框盒子在底部触发整段滚动、塌缩成多个盒子）。
 *   - 非 TTY（管道 / 测试）完全禁用，不输出任何内容。
 */

export type StatusMode = 'normal' | 'plan';

export interface StatusBarState {
  /** 模型名（如 agnes-2.0-flash） */
  model: string;
  /** git 分支 */
  branch: string;
  /** 当前模式 */
  mode: StatusMode;
  /** 成本文本（已带货币符号，如 ¥0.0015） */
  costText: string;
  /** 是否显示上下文占用率（生成期间隐藏） */
  showCtx: boolean;
  /** 上下文占用率 0-100（仅 showCtx 为 true 时显示） */
  ctxPct?: number;
  /** 会话起始时间（ms epoch），用于计算时长 */
  startedAt: number;
}

export interface StatusBarOpts {
  /** 输出目标（默认 process.stdout） */
  out?: OutputSink;
  /** 是否启用（默认 true；--no-statusline 时 false） */
  enabled?: boolean;
}

export class StatusBar {
  private readonly out: OutputSink;
  private enabled: boolean;
  private state: StatusBarState | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly tty: boolean;
  /**
   * 重绘状态栏后「光标应回到的位置」。由调用方（输入框 LineEditor / 生成动画
   * StatusLine）在各自定位光标后调用 setCaret 维护。这样即便终端忽略
   * ESC[s/ESC[u 保存/恢复序列，也能把光标精确送回活动区域，而不是落在最底状态栏。
   */
  private caret = { row: 1, col: 1 };

  constructor(opts: StatusBarOpts = {}) {
    this.out = opts.out ?? process.stdout;
    this.enabled = opts.enabled ?? true;
    this.tty = !!(this.out as OutputSink & { isTTY?: boolean }).isTTY;
  }

  private rows(): number {
    return (this.out as OutputSink & { rows?: number }).rows ?? 24;
  }

  private cols(): number {
    return (this.out as OutputSink & { columns?: number }).columns ?? 80;
  }

  /**
   * 设定状态栏重绘后光标应回到的行/列。由调用方在定位完自身光标后调用，
   * 使 render() 能精确把光标送回活动区域（参见 caret 字段说明）。
   */
  setCaret(row: number, col: number): void {
    this.caret = { row, col };
  }

  /** 启动：记录初始状态、启动每秒刷新 */
  start(state: StatusBarState): void {
    this.state = state;
    if (!this.enabled || !this.tty) return;
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => this.render(), 1000);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    this.render();
  }

  /** 局部更新（模型/分支/模式/成本/ctx 任一变化即重绘） */
  update(patch: Partial<StatusBarState>): void {
    if (!this.state) {
      this.state = {
        model: '',
        branch: '',
        mode: 'normal',
        costText: '',
        showCtx: true,
        startedAt: Date.now(),
      };
    }
    this.state = { ...this.state, ...patch };
    this.render();
  }

  /** 停止每秒刷新（保留显示内容，由 release 真正清理） */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private duration(): string {
    if (!this.state) return '00:00';
    const s = Math.floor((Date.now() - this.state.startedAt) / 1000);
    const mm = String(Math.floor(s / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    return `${mm}:${ss}`;
  }

  /** 拼出状态栏文本（不含底色，行末 chalk 自动复位） */
  private build(): string {
    const st = this.state!;
    const segs: string[] = [];
    segs.push(ui.primary(st.model)); // 模型名：青色突出
    segs.push(chalk.gray(st.branch)); // 分支：灰色
    if (st.showCtx && st.ctxPct != null) {
      segs.push(st.ctxPct >= 80 ? chalk.yellow(`${st.ctxPct}% ctx`) : chalk.gray(`${st.ctxPct}% ctx`));
    }
    segs.push(chalk.green(st.costText)); // 成本：绿色
    segs.push(chalk.gray(this.duration())); // 会话时长
    segs.push(st.mode === 'plan' ? chalk.yellow('规划') : chalk.green('正常')); // 模式
    return segs.join(chalk.gray(' · '));
  }

  /** 把状态栏写到屏幕最底行的绝对位置，并把光标移回调用方维护的活动位置 */
  render(): void {
    if (!this.enabled || !this.tty || !this.state) return;
    const r = this.rows();
    const c = Math.max(1, Math.min(this.cols(), this.caret.col));
    const rr = Math.max(1, Math.min(r, this.caret.row));
    this.out.write(`\x1b[${r};1H\x1b[K` + this.build());
    // 显式把光标移回活动区域（不依赖 ESC[s/u，兼容忽略该序列的终端）
    this.out.write(`\x1b[${rr};${c}H`);
  }

  /** 退出时：清掉状态栏所在行 */
  release(): void {
    this.stop();
    if (this.tty) {
      const r = this.rows();
      this.out.write(`\x1b[${r};1H\x1b[K`);
    }
  }
}
