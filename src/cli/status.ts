import chalk from 'chalk';
import type { OutputSink } from './renderer';

/**
 * 终端「状态行」：让用户在模型思考 / 调工具 / 流式输出期间，始终能看到一个
 * 「在动的东西」——脉动字形（✢→✥→✢）+ 当前在干什么 + 实时秒数与 token 数。
 *
 * 参考 Claude Code 的 `✢ Seasoning… (41s · ↓ 282 tokens)`：
 *   - 字形在 `SPIN` 间轮转，视觉上「变大变小」，避免呆板；
 *   - 思考 / 调工具时显示「(Ns)」；流式输出时额外显示「↓ N tokens」实时增长；
 *   - 状态行恒为屏幕最后一行，流式正文（body）写在其上方。
 *
 * 渲染模型（关键，避免旧版「光标错位导致整屏乱跳」的 bug）：
 *   - 每次 render() 都把「上一次自己画的区域」整体清掉再重画，靠记录上一次占用
 *     的行数 prevLines 精准回到区域顶部（绝不越界到上方已写好的输入行 / 分隔线 /
 *     欢迎面板），因此不会再把历史内容层层覆盖。
 *   - stop() 只擦掉最底部状态行、保留上方正文（那才是模型回复，必须留下）。
 *
 * 非 TTY（管道 / 测试）退化为「直接写正文文本」，不画任何动画，保证可解析输出。
 */

// 脉动字形序列：由小渐大再收回，营造「持续变化」的思考感
const SPIN = ['✢', '✣', '✤', '✥', '✤', '✣'];

export interface StatusLineOpts {
  /** 正文着色函数（默认不强制着色，跟随终端前景色） */
  color?: (s: string) => string;
  /** 输出目标（默认 process.stdout） */
  out?: OutputSink;
  /** 动画帧间隔（ms） */
  intervalMs?: number;
  /**
   * 可选的 Markdown 渲染器：传入后，流式正文会被当作 Markdown 实时渲染
   * （标题/粗体/列表/代码块等→终端 ANSI）。非 TTY 下忽略（直接输出纯文本）。
   * 签名：(markdown源码, 终端宽度) => 每一屏显行。
   */
  markdown?: (md: string, width: number) => string[];
}

type Mode = 'idle' | 'thinking' | 'tool' | 'stream';

export class StatusLine {
  private readonly color: (s: string) => string;
  private readonly out: OutputSink;
  private readonly intervalMs: number;
  private readonly tty: boolean;
  /** 可选的 Markdown 渲染器（TTY 下把正文渲染成 Markdown） */
  private readonly md: ((md: string, width: number) => string[]) | null;

  private timer: ReturnType<typeof setInterval> | null = null;
  private frame = 0;
  private mode: Mode = 'idle';
  private label = '思考中…';
  private startedAt = 0;
  private estTokens = 0;
  /** 流式正文累积（仅 TTY 下常用，用于整体重绘） */
  private body = '';
  /** 上一次 render 占用的行数（含 1 行 footer），用于精准回到区域顶部清屏 */
  private prevLines = 0;
  /** 流式模式下是否有新正文到达、需要重绘 */
  private dirty = false;

  constructor(opts: StatusLineOpts = {}) {
    this.color = opts.color ?? ((s) => s);
    this.out = opts.out ?? process.stdout;
    this.intervalMs = opts.intervalMs ?? 120;
    this.tty = !!process.stdout.isTTY;
    this.md = opts.markdown ?? null;
  }

  /** 开新一轮：显示「思考中…」并启动动画 */
  begin(label = '思考中…'): void {
    this.mode = 'thinking';
    this.label = label;
    this.startedAt = Date.now();
    this.estTokens = 0;
    this.frame = 0;
    this.body = '';
    this.prevLines = 0;
    this.dirty = false;
    if (!this.tty) return; // 非 TTY 不画任何动画，保持输出纯净
    this.render(); // 首帧（区域为空，直接画在光标当前行）
    this.startTimer();
  }

  /** 切换标签（自动上下文注入等），动画继续 */
  setLabel(label: string): void {
    if (this.mode === 'idle') return;
    this.label = label;
    this.dirty = true;
  }

  /** 模型开始调用工具：切到工具态并显示工具名 */
  toolStart(name: string): void {
    if (this.mode === 'idle') return;
    this.mode = 'tool';
    this.label = `🔧 调用工具 ${name}`;
    this.dirty = true;
  }

  /** 工具返回 */
  toolDone(name: string, ok: boolean): void {
    if (this.mode === 'idle') return;
    this.mode = 'tool';
    this.label = `${ok ? '✓' : '✗'} ${name}`;
    this.dirty = true;
  }

  /** 回到「思考中」态（例如工具返回后、下一次模型调用前） */
  thinking(): void {
    if (this.mode === 'idle') return;
    this.mode = 'thinking';
    this.label = '思考中…';
    this.dirty = true;
  }

  /** 流式正文：累积到 body，下一帧统一重绘（正文位于 footer 上方） */
  pushText(chunk: string): void {
    if (!this.tty) {
      this.out.write(this.color(chunk));
      return;
    }
    if (this.mode !== 'stream') {
      this.mode = 'stream';
      this.label = '生成回复中…';
    }
    this.body += chunk;
    this.estTokens += estimateTokens(chunk);
    this.dirty = true;
  }

  /** 结束本轮：清除状态行，保留上方正文（模型回复），留出干净新行供后续输出 */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (!this.tty) {
      this.out.write('\n');
      this.mode = 'idle';
      this.body = '';
      return;
    }
    // 光标此刻在 footer 行末尾；回行首清掉整行 footer，再换行到干净新行
    if (this.prevLines > 0) {
      this.out.write('\r\x1b[K');
    }
    this.out.write('\n');
    this.mode = 'idle';
    this.prevLines = 0;
    this.body = '';
  }

  // ===================== 内部 =====================

  private startTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.frame++;
      if (this.mode === 'idle' || !this.tty) return;
      // 思考 / 工具态：每帧都重绘（仅 1 行 footer，几乎无闪烁）以驱动动画；
      // 流式态：仅当正文有更新才重绘，避免整段正文被反复擦写产生闪烁。
      if (this.mode === 'stream') {
        if (this.dirty) this.render();
      } else {
        this.render();
      }
    }, this.intervalMs);
    // 不让定时器阻止进程退出（runAgent 会 await 完，但兜底一下）
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  private elapsedSec(): number {
    return Math.max(0, Math.round((Date.now() - this.startedAt) / 1000));
  }

  private footerLine(): string {
    const sec = this.elapsedSec();
    const glyph = SPIN[this.frame % SPIN.length];
    if (this.mode === 'stream') {
      return `${chalk.cyan(glyph)} ${chalk.bold.gray(this.label)} ${chalk.gray(`(${sec}s · ↓ ${this.estTokens} tokens)`)}`;
    }
    return `${chalk.cyan(glyph)} ${chalk.bold.gray(this.label)} ${chalk.gray(`(${sec}s)`)}`;
  }

  /** 计算流式正文应当显示的屏显行（Markdown 模式实时渲染，否则纯文本按宽度折行） */
  private bodyLines(width: number): string[] {
    if (!this.body) return []; // 空正文不占行，避免 footer 上方多出空行
    if (this.md && this.tty) {
      const lines = this.md(this.body, width);
      return lines.length ? lines : [];
    }
    return this.wrapPlain(this.body, width);
  }

  /** 纯文本按终端宽度折行（CJK 按 2 列、latin 尽量按词），返回每一屏显行 */
  private wrapPlain(body: string, width: number): string[] {
    const lines: string[] = [];
    for (const para of body.split('\n')) {
      if (para === '') {
        lines.push('');
        continue;
      }
      // 分词：CJK 单字成词、连续非空白非 CJK 成词、空白成词
      const tokens = para.match(/[一-鿿]|[^\s一-鿿]+|\s+/g) ?? [para];
      let line = '';
      let lineW = 0;
      for (const tok of tokens) {
        const tw = displayWidth(tok);
        if (lineW + tw > width && lineW > 0) {
          lines.push(line);
          line = '';
          lineW = 0;
        }
        line += tok;
        lineW += tw;
      }
      lines.push(line);
    }
    return lines;
  }

  /** 整段重绘：回到上一次区域顶部清屏 → 写 body → 写 footer */
  private render(): void {
    const sink = this.out as OutputSink & { columns?: number; rows?: number };
    const width = sink.columns ?? process.stdout.columns ?? 80;
    const rows = sink.rows ?? process.stdout.rows ?? 24;
    const bodyLines = this.bodyLines(width);
    const footer = this.footerLine();

    // 回到上一次自己画的区域顶部（最多上移 rows-1，避免清到已滚出视野的上方内容）。
    // 区域共 prevLines 行、footer 是最后一行，故从 footer 末行回退到顶部需 prevLines-1 行。
    const up = Math.min(Math.max(0, this.prevLines - 1), Math.max(0, rows - 1));
    if (up > 0) this.out.write(`\x1b[${up}A`);
    this.out.write('\r'); // 行首
    this.out.write('\x1b[J'); // 清到屏幕末尾（本区域 + 其下方，绝不动上方）

    if (bodyLines.length > 0) {
      // Markdown 模式：正文自带样式，不再套用统一的 color（避免覆盖）；
      // 纯文本模式：套用 color（如跟随终端前景色）。
      const text = this.md ? bodyLines.join('\n') : this.color(bodyLines.join('\n'));
      this.out.write(text);
      this.out.write('\n');
    }
    this.out.write(footer);
    // 光标停在 footer 行末尾，便于 stop() 精准清行

    this.prevLines = bodyLines.length + 1;
    this.dirty = false;
  }
}

/** 单个字符的显示宽度（CJK / 全角按 2，其余按 1） */
function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    const wide =
      (code >= 0x1100 && code <= 0x115f) || // Hangul Jamo
      (code >= 0x2e80 && code <= 0x303e) || // CJK 部首 / 假名补充
      (code >= 0x3041 && code <= 0x33ff) || // 日文假名 + 标点
      (code >= 0x3400 && code <= 0x4dbf) || // CJK 扩展 A
      (code >= 0x4e00 && code <= 0x9fff) || // CJK 统一表意
      (code >= 0xa000 && code <= 0xa4cf) || // 彝文
      (code >= 0xac00 && code <= 0xd7a3) || // Hangul 音节
      (code >= 0xf900 && code <= 0xfaff) || // 兼容 CJK
      (code >= 0xfe30 && code <= 0xfe4f) || // 竖排标点
      (code >= 0xff00 && code <= 0xff60) || // 全角 ASCII
      (code >= 0xffe0 && code <= 0xffe6) || // 全角符号
      (code >= 0x20000 && code <= 0x3fffd); // CJK 扩展 B+
    w += wide ? 2 : 1;
  }
  return w;
}

/** 粗略估算一段文本的 token 数（CJK 按字计，其余按 ~4 字符/token） */
function estimateTokens(s: string): number {
  const cjk = (s.match(/[一-鿿]/g) || []).length;
  const other = s.length - cjk;
  return cjk + Math.ceil(other / 4);
}
