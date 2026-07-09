import chalk from 'chalk';
import type { OutputSink } from './renderer';
import type { StatusBar } from './statusbar';

/**
 * 终端「状态行」：让用户在模型思考 / 调工具 / 流式输出期间，始终能看到一个
 * 「在动的东西」——脉动字形（✢→✥→✢）+ 当前在干什么 + 实时秒数与 token 数。
 *
 * 参考 Claude Code 的 `✢ Seasoning… (41s · ↓ 282 tokens)`：
 *   - 字形在 `SPIN` 间轮转，视觉上「变大变小」，避免呆板；
 *   - 思考 / 调工具时显示「(Ns)」；流式输出时额外显示「↓ N tokens」实时增长；
 *   - 状态行恒为屏幕最后一行，流式正文（body）写在其上方。
 *
 * 渲染模型（关键，避免「AI 输出向上吞掉已提交输入框 / 历史」的事故）：
 *   - 每轮把「历史(header) + 本轮用户输入(userTurn) + 流式正文(body)」拼成完整
 *     transcript，从顶行（1;1H）统一重绘；footer（思考/工具/流式动画）紧贴正文
 *     最后一行下方（绝不固定在底部留一大段空白），正文超长时从顶部裁剪（早期内容
 *     滚出屏幕，与真实终端滚动一致）。
 *   - 因此正文再长也只会「向下滚动」，绝不会向上覆盖已提交的用户输入框或欢迎面板。
 *   - footer 受 reservedBottom 限制不进入输入框盒子区域；stop() 保留整段正文、
 *     只移除 footer 行动画行，由下方输入框盒子接管。
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
  /**
   * 可选的常驻状态栏。传入后，生成动画的 footer 行让出最底行（画在 rows-1），
   * 最底行留给 StatusBar；每次重绘末尾顺带刷新 StatusBar。
   */
  statusBar?: StatusBar | null;
  /**
   * 底部为输入框预留的行数（含输入框上沿与动画 footer 共占的行）。footer 会钉在
   * 「最底行 - reservedBottom」这一行，transcript 只画在该行之上，从而输入框盒子
   * 出现时绝不会覆盖/吞掉上方正文。典型值 = 输入框高度(3: 上沿+输入行+下沿) + 1
   * （footer 所占的那一行）。非交互（无输入框）时传 0 或不传，footer 落在 rows-1。
   */
  reservedBottom?: number;
}

type Mode = 'idle' | 'thinking' | 'tool' | 'stream';

export class StatusLine {
  private readonly color: (s: string) => string;
  private readonly out: OutputSink;
  private readonly intervalMs: number;
  private readonly tty: boolean;
  /** 可选的 Markdown 渲染器（TTY 下把正文渲染成 Markdown） */
  private readonly md: ((md: string, width: number) => string[]) | null;
  /** 可选的常驻状态栏（footer 让出最底行） */
  private readonly sb: StatusBar | null;
  /** 底部为输入框预留的行数（footer 钉在其上方一行，transcript 只画在盒子之上） */
  private readonly reserved: number;

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
  /**
   * 本轮之前的「历史正文」行（含欢迎面板 splash、历史上各轮的用户输入与模型回复），
   * 每行已是带 ANSI 样式的「屏显行」。render 时与本轮 userTurn + body 拼接成完整
   * transcript 一起从顶行重绘——这样本轮回复再长也只是「从顶部滚动」，绝不会向上
   * 吞掉已提交的用户输入框或上方历史（这正是早期 bottom-anchor 重绘的事故根因）。
   */
  private header: string[] = [];
  /** 本轮已提交的用户输入行（带输入框底色），作为 transcript 中 body 之前的一段 */
  private userTurn: string[] = [];
  /** 最近一次渲染出的 body 行（已套样式），供调用方在回合结束后并入 transcript */
  private lastBodyLines: string[] = [];

  constructor(opts: StatusLineOpts = {}) {
    this.color = opts.color ?? ((s) => s);
    this.out = opts.out ?? process.stdout;
    this.intervalMs = opts.intervalMs ?? 120;
    this.tty = !!process.stdout.isTTY;
    this.md = opts.markdown ?? null;
    this.sb = opts.statusBar ?? null;
    this.reserved = opts.reservedBottom ?? 0;
  }

  /** 设置「历史正文」行（本轮之前的所有内容，调用 begin 前设置） */
  setHeader(lines: string[]): void {
    this.header = lines;
  }

  /** 设置本轮已提交的用户输入行（调用 begin 前设置） */
  setUserTurn(lines: string[]): void {
    this.userTurn = lines;
  }

  /** 取最近一次渲染出的 body 行（已套样式），供回合结束后并入 transcript */
  getBodyLines(): string[] {
    return this.lastBodyLines;
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

  /** 结束本轮：清除 footer 行（保留上方正文即模型回复），并刷新最底状态栏 */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (!this.tty) {
      this.out.write('\n');
      this.mode = 'idle';
      this.body = '';
      this.lastBodyLines = [];
      return;
    }
    // 终帧：保留全部正文（header + userTurn + body），仅移除动画状态行（footer 行留空），
    // 其下方由输入框盒子接管。正文从顶行统一重绘，绝不向上吞掉已提交的用户输入。
    const sink = this.out as OutputSink & { columns?: number; rows?: number };
    const width = sink.columns ?? process.stdout.columns ?? 80;
    const { footerRow, bodyAvail } = this.layout();
    const rawBody = this.bodyLines(width);
    const body = this.md ? rawBody : rawBody.map((l) => this.color(l));
    this.lastBodyLines = body;
    const content = [...this.header, ...this.userTurn, ...body];
    const visible = content.length > bodyAvail ? content.slice(content.length - bodyAvail) : content;
    this.out.write('\x1b[1;1H\x1b[J');
    if (visible.length > 0) this.out.write(visible.join('\n'));
    // footer 行动画行留空（\x1b[J 已清到屏末），其下方留给输入框盒子，正文不被覆盖
    const caretRow = Math.min(footerRow - 1, 1 + visible.length);
    this.sb?.setCaret(caretRow, 1);
    this.sb?.render();
    this.mode = 'idle';
    this.prevLines = 0;
    this.body = '';
  }

  // ===================== 内部 =====================

  /**
   * 计算 footer 行号与正文可用行数。
   * - reservedBottom>0：footer 钉在「最底行 - reservedBottom」一行，其下方留给输入框盒子；
   *   transcript 只画在 footer 之上，盒子出现时绝不覆盖正文。
   * - 否则（无输入框）：有状态栏则 footer 让出最底行（rows-1），否则落 rows。
   */
  private layout(): { footerRow: number; bodyAvail: number } {
    const sink = this.out as OutputSink & { columns?: number; rows?: number };
    const rows = sink.rows ?? process.stdout.rows ?? 24;
    let footerRow: number;
    if (this.reserved > 0) footerRow = rows - this.reserved;
    else if (this.sb) footerRow = rows - 1;
    else footerRow = rows;
    return { footerRow, bodyAvail: footerRow - 1 };
  }

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

  /**
   * 整段重绘（transcript 模型）：把「历史(header) + 本轮用户输入(userTurn) + 流式正文(body)」
   * 拼成完整 transcript，从顶行统一重绘；footer 固定在 footerRow，超长时从顶部裁剪
   * （早期内容滚出屏幕，与真实终端滚动一致）。这样正文再长也只会「向下滚动」，
   * 绝不会像旧版那样向上吞掉已提交的用户输入框或上方历史。
   */
  private render(): void {
    const sink = this.out as OutputSink & { columns?: number; rows?: number };
    const width = sink.columns ?? process.stdout.columns ?? 80;
    const { footerRow: footerCap, bodyAvail } = this.layout();
    const rawBody = this.bodyLines(width);
    // Markdown 模式：正文自带样式，不再套 color（避免覆盖）；纯文本模式：套 color
    const body = this.md ? rawBody : rawBody.map((l) => this.color(l));
    this.lastBodyLines = body;
    const content = [...this.header, ...this.userTurn, ...body];
    // 内容超过可视高度则从顶部裁剪（早期内容滚出屏幕，与真实终端滚动一致）
    const visible = content.length > bodyAvail ? content.slice(content.length - bodyAvail) : content;

    // 从顶行清屏并重绘整段 transcript（header + userTurn + body）
    this.out.write('\x1b[1;1H\x1b[J');
    if (visible.length > 0) this.out.write(visible.join('\n'));
    // 动画状态行（思考 / 工具 / 流式）的位置：
    //  - 交互模式（reservedBottom>0，有输入框）：紧贴正文最后一行下方（visible.length+1），
    //    让「思考中…」始终贴着 AI 输出；同时受 footerCap 限制不进入输入框盒子区域。
    //  - 非交互模式（one-shot / 管道）：仍钉在底部 footerCap（与 Claude Code 一致）。
    const footerRow =
      this.reserved > 0 ? Math.min(visible.length + 1, footerCap) : footerCap;
    this.out.write(`\x1b[${footerRow};1H\x1b[K` + this.footerLine());

    this.prevLines = visible.length + 1;
    this.dirty = false;
    // 顺带刷新最底状态栏，并把光标送回 footer 行末尾（不依赖 ESC[s/u 保存/恢复）
    const footerCol = displayWidth(this.footerLine()) + 1;
    this.sb?.setCaret(footerRow, footerCol);
    this.sb?.render();
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
