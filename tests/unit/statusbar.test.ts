/**
 * StatusBar（状态栏）单元测试 + 伪终端 VT 集成测试。
 *
 * 重点验证：状态栏恒驻最底行（rows），不被输入框盒子（LineEditor）与生成动画
 * （StatusLine）的「清到屏幕末」序列覆写；二者共存时上方内容（模型回复、用户输入）
 * 完好保留。这正是之前 StatusLine off-by-one 覆写事故要避免的。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { StatusBar } from '../../src/cli/statusbar';
import { StatusLine } from '../../src/cli/status';
import { LineEditor } from '../../src/cli/line-editor';
import { renderMarkdown } from '../../src/cli/markdown';
import { ui } from '../../src/cli/theme';

// ───────────────────────── 伪终端 VT 模拟器 ─────────────────────────
// 支持本项目用到的转义序列：\r \n \x1b[s/u \x1b[row;colH \x1b[K \x1b[J
// \x1b[1;Nr(滚动区) \x1b[r(复位) \x1b[A/B/C/D \x1b[2J \x1b[H，以及忽略 SGR(\x1b[..m)。
class VT {
  rows: number;
  cols: number;
  screen: string[][];
  cur = { row: 1, col: 1 };
  saved = { row: 1, col: 1 };
  scrollTop = 1;
  scrollBottom: number;
  text = ''; // 完整写入流（用于断言序列）

  constructor(rows: number, cols: number) {
    this.rows = rows;
    this.cols = cols;
    this.scrollBottom = rows;
    this.screen = Array.from({ length: rows }, () => Array.from({ length: cols }, () => ' '));
  }

  private blankRow(): string[] {
    return Array.from({ length: this.cols }, () => ' ');
  }

  write(s: string): boolean {
    this.text += s;
    this.apply(s);
    return true;
  }

  private apply(s: string): void {
    let i = 0;
    while (i < s.length) {
      const ch = s[i]!;
      if (ch === '\x1b') {
        i = this.applyEscape(s, i);
        continue;
      }
      if (ch === '\r') {
        this.cur.col = 1;
      } else if (ch === '\n') {
        if (this.cur.row < this.scrollBottom) this.cur.row++;
        else this.scrollUp();
        this.cur.col = 1;
      } else {
        // 普通字符：放光标处，右移；超宽则折行
        if (this.cur.col > this.cols) {
          this.cur.col = 1;
          if (this.cur.row < this.scrollBottom) this.cur.row++;
          else this.scrollUp();
        }
        this.screen[this.cur.row - 1]![this.cur.col - 1] = ch;
        this.cur.col++;
      }
      i++;
    }
  }

  private scrollUp(): void {
    for (let r = this.scrollTop; r < this.scrollBottom; r++) {
      this.screen[r - 1] = this.screen[r]!;
    }
    this.screen[this.scrollBottom - 1] = this.blankRow();
  }

  private applyEscape(s: string, i: number): number {
    // ESC 后直接跟字母：save/restore/reset-scroll
    const nxt = s[i + 1];
    if (nxt === 's') {
      this.saved = { ...this.cur };
      return i + 2;
    }
    if (nxt === 'u') {
      this.cur = { ...this.saved };
      return i + 2;
    }
    if (nxt === 'r') {
      this.scrollTop = 1;
      this.scrollBottom = this.rows;
      return i + 2;
    }
    if (nxt === '[') {
      // CSI：收集参数直到终止字母
      let j = i + 2;
      let param = '';
      while (j < s.length && !/[A-Za-z]/.test(s[j]!)) {
        param += s[j];
        j++;
      }
      const cmd = s[j]!;
      this.applyCsi(cmd, param);
      return j + 1;
    }
    // 其它 ESC 序列忽略
    return i + (nxt ? 2 : 1);
  }

  private applyCsi(cmd: string, param: string): void {
    const nums = param.split(';').map((x) => (x === '' ? 1 : parseInt(x, 10)));
    const n = (k: number) => (nums[k] && !Number.isNaN(nums[k]) ? nums[k] : 1);
    switch (cmd) {
      case 'H':
        this.cur.row = Math.min(this.rows, Math.max(1, n(0)));
        this.cur.col = Math.min(this.cols, Math.max(1, n(1)));
        break;
      case 'K': {
        // 清到行末
        for (let c = this.cur.col - 1; c < this.cols; c++) this.screen[this.cur.row - 1]![c] = ' ';
        break;
      }
      case 'J': {
        // 清到屏幕末（物理）
        for (let r = this.cur.row - 1; r < this.rows; r++) {
          if (r === this.cur.row - 1) {
            for (let c = this.cur.col - 1; c < this.cols; c++) this.screen[r]![c] = ' ';
          } else {
            this.screen[r] = this.blankRow();
          }
        }
        break;
      }
      case 'r': {
        // 设置滚动区 ESC[top;bottom r（top 默认 1）
        const top = n(0);
        const bottom = param.includes(';') ? n(1) : this.rows;
        if (top >= 1 && bottom <= this.rows && bottom > top) {
          this.scrollTop = top;
          this.scrollBottom = bottom;
        }
        break;
      }
      case 'A':
        this.cur.row = Math.max(1, this.cur.row - n(0));
        break;
      case 'B':
        this.cur.row = Math.min(this.rows, this.cur.row + n(0));
        break;
      case 'C':
        this.cur.col = Math.min(this.cols, this.cur.col + n(0));
        break;
      case 'D':
        this.cur.col = Math.max(1, this.cur.col - n(0));
        break;
      case '2':
        if (s_param_is_clear(param)) {
          this.screen = Array.from({ length: this.rows }, () => this.blankRow());
          this.cur = { row: 1, col: 1 };
        }
        break;
      default:
        break;
    }
  }

  /** 返回第 row 行（1-indexed）的 trimmed 文本 */
  line(row: number): string {
    return this.screen[row - 1]!.join('').replace(/\s+$/, '');
  }

  /** 去掉 ANSI 后 dump 某行 */
  dump(row: number): string {
    return this.line(row);
  }
}

function s_param_is_clear(param: string): boolean {
  return param.startsWith('2') && param.length === 1;
}

function makeOut(vt: VT) {
  const out: any = {
    write: (s: string) => vt.write(s),
    isTTY: true,
    columns: vt.cols,
    rows: vt.rows,
    // LineEditor 用 out.on('resize') / out.removeListener('resize')，伪终端无需真正监听
    on() {
      return out;
    },
    removeListener() {
      return out;
    },
  };
  return out as unknown as NodeJS.WriteStream & { write: (s: string) => boolean };
}

function makeStdin() {
  const handlers: Record<string, ((b: Buffer) => void)[]> = {};
  const stdin = {
    isTTY: true,
    setRawMode() {},
    resume() {},
    pause() {},
    on(ev: string, cb: (b: Buffer) => void) {
      (handlers[ev] ||= []).push(cb);
      return stdin;
    },
    removeListener(ev: string, cb: (b: Buffer) => void) {
      handlers[ev] = (handlers[ev] || []).filter((h) => h !== cb);
      return stdin;
    },
    emitData(b: Buffer) {
      (handlers['data'] || []).forEach((h) => h(b));
    },
  };
  return stdin;
}

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

/** 测试用：单字符显示宽度（CJK/全角按 2，其余按 1），与 line-editor.displayWidth 一致 */
const dispWidth = (s: string): number => {
  let w = 0;
  for (const ch of s) w += ch.charCodeAt(0) > 0x2e80 ? 2 : 1;
  return w;
};

// ───────────────────────── 单元测试 ─────────────────────────

describe('StatusBar 单元', () => {
  function newVT(rows = 10, cols = 200) {
    return new VT(rows, cols);
  }

  it('启动不设置滚动区，用绝对定位把状态栏写到最底行', () => {
    const vt = newVT();
    const sb = new StatusBar({ out: makeOut(vt), enabled: true });
    sb.start({ model: 'agnes-2.0-flash', branch: 'main', mode: 'normal', costText: '¥0', showCtx: true, ctxPct: 12, startedAt: Date.now() });
    expect(vt.text).not.toContain('\x1b[1;9r'); // 不再设置滚动区（避免干扰输入框盒子）
    expect(vt.text).toContain('\x1b[10;1H'); // 状态栏在最底行 10（绝对定位）
    expect(stripAnsi(vt.line(10))).toContain('agnes-2.0-flash');
    expect(stripAnsi(vt.line(10))).toContain('main');
    expect(stripAnsi(vt.line(10))).toContain('12% ctx');
    expect(stripAnsi(vt.line(10))).toContain('¥0');
    expect(stripAnsi(vt.line(10))).toContain('正常');
  });

  it('update 刷新最底行并把光标送回 setCaret 维护的活动位置（不依赖 ESC[s/u）', () => {
    const vt = newVT();
    const sb = new StatusBar({ out: makeOut(vt), enabled: true });
    sb.start({ model: 'm', branch: 'b', mode: 'normal', costText: '¥0', showCtx: false, startedAt: Date.now() });
    // 调用方（输入框/动画）在各自定位光标后维护 caret
    sb.setCaret(5, 3);
    const before = vt.text.length;
    sb.update({ costText: '¥0.5' });
    const seg = vt.text.slice(before);
    expect(seg).not.toContain('\x1b[s'); // 不再使用保存/恢复序列（部分终端忽略）
    expect(seg).not.toContain('\x1b[u');
    expect(seg).toContain('\x1b[10;1H'); // 状态栏绝对定位在最底行
    expect(seg).toContain('\x1b[5;3H'); // 光标被显式送回活动位置 (5,3)
    expect(stripAnsi(vt.line(10))).toContain('¥0.5');
  });

  it('release 清最底行（不再复位滚动区）', () => {
    const vt = newVT();
    const sb = new StatusBar({ out: makeOut(vt), enabled: true });
    sb.start({ model: 'm', branch: 'b', mode: 'normal', costText: '¥0', showCtx: false, startedAt: Date.now() });
    sb.release();
    expect(vt.text).not.toContain('\x1b[r'); // 不再使用滚动区，故不复位
    expect(stripAnsi(vt.line(10))).toBe(''); // 最底行被清空
  });

  it('禁用时不输出任何内容', () => {
    const vt = newVT();
    const sb = new StatusBar({ out: makeOut(vt), enabled: false });
    sb.start({ model: 'm', branch: 'b', mode: 'normal', costText: '¥0', showCtx: false, startedAt: Date.now() });
    sb.update({ costText: '¥9' });
    expect(vt.text).toBe('');
  });

  it('生成期间隐藏 ctx%（showCtx=false）', () => {
    const vt = newVT();
    const sb = new StatusBar({ out: makeOut(vt), enabled: true });
    sb.start({ model: 'm', branch: 'b', mode: 'normal', costText: '¥0', showCtx: false, ctxPct: 88, startedAt: Date.now() });
    expect(stripAnsi(vt.line(10))).not.toContain('ctx');
    sb.update({ showCtx: true });
    expect(stripAnsi(vt.line(10))).toContain('88% ctx');
  });
});

// ───────────────────────── StatusLine + StatusBar 集成（真动画路径） ─────────────────────────
describe('StatusLine + StatusBar 集成（伪 TTY）', () => {
  let realStdoutIsTty: PropertyDescriptor | undefined;
  beforeEach(() => {
    realStdoutIsTty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
  });
  afterEach(() => {
    if (realStdoutIsTty) Object.defineProperty(process.stdout, 'isTTY', realStdoutIsTty);
    else Object.defineProperty(process.stdout, 'isTTY', { value: undefined, configurable: true });
    vi.useRealTimers();
  });

  it('生成动画 footer 在 rows-1，状态栏在 rows，停止后回复与状态栏均保留', () => {
    vi.useFakeTimers();
    const vt = new VT(10, 200);
    const sb = new StatusBar({ out: makeOut(vt), enabled: true });
    sb.start({ model: 'agnes', branch: 'main', mode: 'normal', costText: '¥0', showCtx: true, ctxPct: 5, startedAt: Date.now() });
    const statusLine = new StatusLine({ out: makeOut(vt), color: ui.assistant, markdown: renderMarkdown, statusBar: sb });

    statusLine.begin('思考中…');
    statusLine.pushText('这是模型回复的第一行。\n这是第二行。');
    vi.advanceTimersByTime(200); // 触发动画定时器重绘

    // footer 应在第 9 行（rows-1），状态栏在第 10 行
    expect(stripAnsi(vt.line(9))).toMatch(/思考中|生成回复中|✢|✣|✤|✥/);
    expect(stripAnsi(vt.line(10))).toContain('agnes'); // 状态栏完好
    expect(stripAnsi(vt.line(10))).toContain('main');

    // 回复正文从顶行（transcript 模型）渲染，落在上方区域，且没被清掉
    const body = [1, 2, 3, 4, 5, 6, 7, 8].map((r) => stripAnsi(vt.line(r))).join(' ');
    expect(body).toContain('这是模型回复的第一行');
    expect(body).toContain('这是第二行');

    statusLine.stop();
    // 停止后 footer 行（第 9 行）被清空，但回复正文与状态栏保留
    expect(stripAnsi(vt.line(9))).toBe('');
    expect(stripAnsi(vt.line(10))).toContain('agnes'); // 状态栏仍在
    const bodyAfter = [1, 2, 3, 4, 5, 6, 7, 8].map((r) => stripAnsi(vt.line(r))).join(' ');
    expect(bodyAfter).toContain('这是模型回复的第一行');
  });

  it('长回复从顶行滚动，绝不上吞已提交的用户输入框', () => {
    vi.useFakeTimers();
    const vt = new VT(24, 200);
    const sb = new StatusBar({ out: makeOut(vt), enabled: true });
    sb.start({ model: 'agnes', branch: 'main', mode: 'normal', costText: '¥0', showCtx: true, ctxPct: 5, startedAt: Date.now() });
    const statusLine = new StatusLine({ out: makeOut(vt), color: ui.assistant, markdown: renderMarkdown, statusBar: sb });
    // 历史正文 + 本轮已提交的用户输入（带输入框底色的一行）
    statusLine.setHeader(['欢迎面板第 1 行', '欢迎面板第 2 行']);
    statusLine.setUserTurn(['> 这是已提交的用户输入（输入框底色行）']);

    statusLine.begin('思考中…');
    // 一段中等长度回复，确保它出现在已提交输入框「下方」而非覆盖它
    statusLine.pushText('回复第 1 行\n回复第 2 行\n回复第 3 行');
    vi.advanceTimersByTime(200);

    // 已提交的用户输入框必须仍然存在（未被回复正文吞掉）
    const upper = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((r) => stripAnsi(vt.line(r))).join('\n');
    const committedRow = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].find((r) => stripAnsi(vt.line(r)).includes('这是已提交的用户输入'))!;
    expect(committedRow).toBeGreaterThan(0); // 提交行确实存在
    expect(upper).toContain('回复第 1 行');
    expect(upper).toContain('回复第 2 行');
    expect(upper).toContain('回复第 3 行');
    // 回复应出现在提交行「之后」（上方内容完整，回复在下方追加，而非覆盖）
    const firstReplyRow = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].find((r) => stripAnsi(vt.line(r)).includes('回复第 1 行'))!;
    expect(firstReplyRow).toBeGreaterThan(committedRow);

    // footer 在 rows-1、状态栏在 rows，均完好
    expect(stripAnsi(vt.line(23))).toMatch(/思考中|生成回复中|✢|✣|✤|✥/);
    expect(stripAnsi(vt.line(24))).toContain('agnes');

    statusLine.stop();
    // 停止后提交行与回复仍保留，footer 行清空
    expect(stripAnsi(vt.line(23))).toBe('');
    expect(stripAnsi(vt.line(24))).toContain('agnes');
    const after = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((r) => stripAnsi(vt.line(r))).join('\n');
    expect(after).toContain('这是已提交的用户输入');
    expect(after).toContain('回复第 1 行');
  });

  it('reservedBottom:4 时 footer 钉在 rows-4，盒子区 rows-3..rows-1 留空，用户问题不被吞', () => {
    vi.useFakeTimers();
    const vt = new VT(24, 200);
    const sb = new StatusBar({ out: makeOut(vt), enabled: true });
    sb.start({ model: 'agnes', branch: 'main', mode: 'normal', costText: '¥0', showCtx: true, ctxPct: 5, startedAt: Date.now() });
    // 新模型：header 不含欢迎面板（只在启动空闲显示一次），避免长回复时吞掉用户问题
    const statusLine = new StatusLine({
      out: makeOut(vt),
      color: ui.assistant,
      markdown: renderMarkdown,
      statusBar: sb,
      reservedBottom: 4, // 为输入框预留底部 4 行（盒子 3 行 + footer 1 行）
    });
    statusLine.setHeader([]);
    statusLine.setUserTurn(['> 这是用户的问题']);

    statusLine.begin('思考中…');
    statusLine.pushText('回复第 1 行\n回复第 2 行\n回复第 3 行');
    vi.advanceTimersByTime(200);

    // 用户的问题必须保留在第 1 行（绝不被回复吞掉）
    expect(stripAnsi(vt.line(1))).toContain('这是用户的问题');
    // 回复正文出现在问题之后（Markdown 渲染可能加段落间距，故在 rows 2..19 范围内查找）
    const replyRegion = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]
      .map((r) => stripAnsi(vt.line(r)))
      .join('\n');
    expect(replyRegion).toContain('回复第 1 行');
    expect(replyRegion).toContain('回复第 2 行');
    expect(replyRegion).toContain('回复第 3 行');
    // footer 紧贴正文（Markdown 把连续 3 行合并为 1 段，故可见内容 = 用户问题1行
    // + 回复1行 = 2 行，footer 落在第 3 行），而非钉在底部——
    // 「思考中…」应贴着 AI 输出；同时受 reservedBottom 限制绝不进入盒子区。
    expect(stripAnsi(vt.line(3))).toMatch(/思考中|生成回复中|✢|✣|✤|✥/);
    // 输入框盒子区（rows-3..rows-1 = 21~23 行）在生成期间必须留空，
    // 这样生成结束后输入框盒子画上去时不会覆盖任何回复内容
    expect(stripAnsi(vt.line(21))).toBe('');
    expect(stripAnsi(vt.line(22))).toBe('');
    expect(stripAnsi(vt.line(23))).toBe('');
    // 状态栏仍在最底行
    expect(stripAnsi(vt.line(24))).toContain('agnes');

    statusLine.stop();
    // 停止后 footer 行（20）清空，盒子区仍留空，问题+回复保留
    expect(stripAnsi(vt.line(20))).toBe('');
    expect(stripAnsi(vt.line(21))).toBe('');
    expect(stripAnsi(vt.line(22))).toBe('');
    expect(stripAnsi(vt.line(23))).toBe('');
    expect(stripAnsi(vt.line(1))).toContain('这是用户的问题');
    const afterReply = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]
      .map((r) => stripAnsi(vt.line(r)))
      .join('\n');
    expect(afterReply).toContain('回复第 1 行');
    expect(stripAnsi(vt.line(24))).toContain('agnes');
  });

  it('reservedBottom:4 时超长回复 footer 受 cap 限制钉在 rows-4、不进入盒子区', () => {
    vi.useFakeTimers();
    const vt = new VT(24, 200);
    const sb = new StatusBar({ out: makeOut(vt), enabled: true });
    sb.start({ model: 'agnes', branch: 'main', mode: 'normal', costText: '¥0', showCtx: true, ctxPct: 5, startedAt: Date.now() });
    const statusLine = new StatusLine({
      out: makeOut(vt),
      color: ui.assistant,
      markdown: renderMarkdown,
      statusBar: sb,
      reservedBottom: 4,
    });
    statusLine.setHeader([]);
    statusLine.setUserTurn(['> 用户的问题']);
    // 30 段超长回复（每段间用空行分隔，Markdown 渲染为独立块）：footer 应被 cap 在
    // rows-4（20），绝不进入盒子区 rows-3..rows-1
    const longBody = Array.from({ length: 30 }, (_, i) => `回复第 ${i + 1} 行`).join('\n\n');
    statusLine.begin('思考中…');
    statusLine.pushText(longBody);
    vi.advanceTimersByTime(200);

    // footer 被 cap 在 rows-4（20），而不是跟随超长正文滚到下方
    expect(stripAnsi(vt.line(20))).toMatch(/思考中|生成回复中|✢|✣|✤|✥/);
    // 盒子区 rows-3..rows-1（21~23）仍然留空
    expect(stripAnsi(vt.line(21))).toBe('');
    expect(stripAnsi(vt.line(22))).toBe('');
    expect(stripAnsi(vt.line(23))).toBe('');
    // 回复从顶部滚动裁剪，最新的回复出现在接近 footer 的上方区域
    const tailRegion = [16, 17, 18, 19].map((r) => stripAnsi(vt.line(r))).join('\n');
    expect(tailRegion).toContain('回复第 30 行');
    expect(stripAnsi(vt.line(24))).toContain('agnes');
  });
});

// ───────────────────────── LineEditor + StatusBar 集成（真输入框盒子） ─────────────────────────
describe('LineEditor + StatusBar 集成（伪 TTY）', () => {
  let realOut: unknown;
  let realIn: unknown;
  beforeEach(() => {
    realOut = process.stdout;
    realIn = process.stdin;
  });
  afterEach(() => {
    Object.defineProperty(process, 'stdout', { value: realOut, configurable: true });
    Object.defineProperty(process, 'stdin', { value: realIn, configurable: true });
    vi.useRealTimers();
  });

  function setup() {
    const vt = new VT(10, 200);
    // 替换全局 process.stdout / stdin 为伪终端
    Object.defineProperty(process, 'stdout', { value: makeOut(vt), configurable: true });
    const stdin = makeStdin();
    Object.defineProperty(process, 'stdin', { value: stdin, configurable: true });
    return { vt, stdin };
  }

  it('输入框盒子在 rows-2..rows-1，状态栏恒在 rows，提交后输入保留在上方', async () => {
    vi.useFakeTimers();
    const { vt, stdin } = setup();
    const sb = new StatusBar({ enabled: true }); // 用 process.stdout（已替换为伪终端）
    sb.start({ model: 'agnes-2.0-flash', branch: 'main', mode: 'normal', costText: '¥0', showCtx: true, ctxPct: 0, startedAt: Date.now() });
    const submitted: string[] = [];
    const editor = new LineEditor({
      prompt: '> ',
      history: [],
      commands: [{ name: 'help', description: '查看帮助' }],
      onSubmit: (l) => submitted.push(l),
      onInterrupt: () => {},
      statusBar: sb,
    });
    const startP = editor.start();

    // 输入 hello
    for (const ch of 'hello') stdin.emitData(Buffer.from(ch));
    // 状态栏在第 10 行
    expect(stripAnsi(vt.line(10))).toContain('agnes');
    // 输入框：顶边横线在第 7 行、输入行在第 8 行、第 9 行（底边）留空（底边横线已移除）
    expect(stripAnsi(vt.line(9))).not.toContain('─'); // 底边横线已移除，第 9 行留空
    expect(stripAnsi(vt.line(8))).toContain('> hello');

    // 回车提交（普通文本走「多行粘贴」debounce，需推进定时器才真正 commit）
    stdin.emitData(Buffer.from('\r'));
    vi.advanceTimersByTime(20); // 触发 flushPaste → commit
    // 提交后输入作为永久行保留在上方（第 7 行附近），状态栏仍在第 10 行
    expect(submitted).toEqual(['hello']);
    const committed = [vt.line(6), vt.line(7), vt.line(8)].map(stripAnsi).join(' ');
    expect(committed).toContain('> hello');
    expect(stripAnsi(vt.line(10))).toContain('agnes'); // 状态栏未被覆写

    editor.exit();
    await startP;
  });

  it('多次按键与退格只产生一个输入框盒子，不出现重复/塌缩', async () => {
    vi.useFakeTimers();
    const { vt, stdin } = setup();
    const sb = new StatusBar({ enabled: true });
    sb.start({ model: 'agnes-2.0-flash', branch: 'main', mode: 'normal', costText: '¥0', showCtx: true, ctxPct: 0, startedAt: Date.now() });
    const submitted: string[] = [];
    const editor = new LineEditor({
      prompt: '> ',
      history: [],
      commands: [{ name: 'help', description: '查看帮助' }],
      onSubmit: (l) => submitted.push(l),
      onInterrupt: () => {},
      statusBar: sb,
    });
    const startP = editor.start();

    // 输入 hello，再退格 3 次 → hel
    for (const ch of 'hello') stdin.emitData(Buffer.from(ch));
    for (let i = 0; i < 3; i++) stdin.emitData(Buffer.from('\b'));

    // 只有 1 个输入框盒子：顶边横线只应出现在第 7 行，第 9 行（底边）应留空无横线，
    // 上方第 1..6 行不应有任何盒子横线或输入提示，证明没有重复/塌缩的输入框。
    const above = [1, 2, 3, 4, 5, 6].map((r) => stripAnsi(vt.line(r)));
    for (const l of above) {
      expect(l).not.toContain('─'); // 无残留盒子横线
      expect(l).not.toContain('> '); // 无残留输入提示
    }
    expect(stripAnsi(vt.line(7))).toContain('─'); // 顶边横线
    expect(stripAnsi(vt.line(8))).toContain('> hel'); // 输入行含退格后的文本
    expect(stripAnsi(vt.line(9))).not.toContain('─'); // 底边横线已移除，第 9 行留空
    expect(stripAnsi(vt.line(10))).toContain('agnes'); // 状态栏完好且唯一

    editor.exit();
    await startP;
  });

  it('输入 / 展开下拉后真实退格(DEL)删除，只保留一个干净输入框', async () => {
    vi.useFakeTimers();
    const { vt, stdin } = setup();
    const sb = new StatusBar({ enabled: true });
    sb.start({ model: 'agnes-2.0-flash', branch: 'main', mode: 'normal', costText: '¥0', showCtx: true, ctxPct: 0, startedAt: Date.now() });
    // 很多命令 → 下拉很高，盒子锚定到靠近顶部
    const cmds = Array.from({ length: 40 }, (_, i) => ({ name: `cmd${i}`, description: `命令 ${i}` }));
    const editor = new LineEditor({
      prompt: '> ',
      history: [],
      commands: cmds,
      onSubmit: () => {},
      onInterrupt: () => {},
      statusBar: sb,
    });
    const startP = editor.start();

    // 输入 /
    stdin.emitData(Buffer.from('/'));
    // 下拉已展开：应能看到命令项
    const withDropdown = [1, 2, 3, 4, 5, 6, 7, 8].map((r) => stripAnsi(vt.line(r))).join('\n');
    expect(withDropdown).toContain('/cmd0');

    // 真实终端退格发 DEL(0x7f)
    stdin.emitData(Buffer.from([0x7f]));

    // 删除后：全屏只有 1 行输入提示（> ），且不再含 '/'
    // 注意：vt.line() 会去掉行尾空白，故用 '>' 而非 '> ' 匹配
    const inputLines = [1, 2, 3, 4, 5, 6, 7, 8, 9].filter((r) => stripAnsi(vt.line(r)).includes('>'));
    expect(inputLines.length).toBe(1); // 恰好一个输入框
    expect(stripAnsi(vt.line(8))).toContain('>'); // 输入行（空，无 /）
    expect(stripAnsi(vt.line(8))).not.toContain('/'); // '/' 已被删除
    expect(stripAnsi(vt.line(10))).toContain('agnes'); // 状态栏完好且唯一

    editor.exit();
    await startP;
  });

  it('draw 后光标停在输入框内（输入行、已输入文本之后），且状态栏刷新不抢走光标', async () => {
    vi.useFakeTimers();
    const { vt, stdin } = setup();
    const sb = new StatusBar({ enabled: true });
    sb.start({ model: 'agnes-2.0-flash', branch: 'main', mode: 'normal', costText: '¥0', showCtx: true, ctxPct: 0, startedAt: Date.now() });
    const editor = new LineEditor({
      prompt: '> ',
      history: [],
      commands: [{ name: 'help', description: '查看帮助' }],
      onSubmit: () => {},
      onInterrupt: () => {},
      statusBar: sb,
    });
    const startP = editor.start();
    for (const ch of 'hello') stdin.emitData(Buffer.from(ch));

    // 输入框盒子：输入行在第 8 行；'> hello' 显示宽度 7 → 光标列应为 8
    const caretCol = dispWidth('> hello') + 1;
    expect(vt.cur.row).toBe(8); // 输入行（非状态栏行 10）
    expect(vt.cur.col).toBe(caretCol); // 停在已输入文本之后
    expect(vt.cur.row).not.toBe(10); // 绝不应落在状态栏行

    // 模拟成本刷新（refreshStatus → update → render）：光标仍应停在输入框内
    sb.update({ costText: '¥0.01' });
    expect(vt.cur.row).toBe(8);
    expect(vt.cur.col).toBe(caretCol);

    // 退格删除一个字符 → 'hell'：光标列应随已输入文本缩短（停在 '> hell' 之后）
    stdin.emitData(Buffer.from([0x7f]));
    expect(vt.cur.row).toBe(8);
    expect(vt.cur.col).toBe(dispWidth('> hell') + 1); // = 7

    editor.exit();
    await startP;
  });
});
