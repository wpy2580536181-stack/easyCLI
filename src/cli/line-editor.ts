// 原生输入编辑器（替代 readline），实现 Claude Code 式的「斜杠命令下拉菜单」。
//
// 为什么不用 readline？
//   readline 无法在「每次按键」时于输入框下方实时画出带说明的筛选列表，
//   它只在 Tab 时列出候选且不带说明。要做到「输入 / 即弹出全部命令及说明、继续
//   输入按全名实时筛选」，必须自己掌控整行渲染 —— 故 TTY 下使用 raw mode 自绘。
//
// 行为：
//   - 输入以 / 开头时，下方弹出全部命令 + 一句话说明；
//   - 继续输入会按「命令全名包含该子串」实时筛选（如 /ex 只显示含 ex 的命令）；
//   - ↑/↓ 在菜单内移动高亮，Tab / Enter 把高亮项填回输入框（唯一匹配时直接执行）；
//   - Esc 清空输入（关闭菜单）；普通文本下 ↑/↓ 翻历史；Ctrl+C 忙时取消/空闲退出；
//     Ctrl+D 退出；Ctrl+L 清屏。
//
// 非 TTY（管道 / 测试）回退到 readline，保证 /exit 等脚本化调用仍然可用。

import readline from 'node:readline';
import chalk from 'chalk';
import type { CommandMeta } from './commands';
import { ui } from './theme';
import type { StatusBar } from './statusbar';

/** 多行粘贴判定的 debounce 窗口（与 repl 保持一致） */
const PASTE_DEBOUNCE_MS = 12;

/** 单个字符的显示宽度（CJK 等宽字符按 2，其余按 1），忽略 ANSI 转义 */
function displayWidth(s: string): number {
  const strip = s.replace(/\x1b\[[0-9;]*m/g, '');
  let w = 0;
  for (const ch of strip) {
    w += ch.charCodeAt(0) > 0x2e80 ? 2 : 1;
  }
  return w;
}

/**
 * 把一行内容渲染成「整行带输入框底色」：内容 + 右侧补空格到终端宽度，
 * 这样行末到屏幕右边缘都有底色（不再只有文字部分有底色、后边空着）。
 */
function paintBoxLine(content: string, width: number): string {
  const pad = Math.max(0, width - displayWidth(content));
  return ui.inputBg(content + ' '.repeat(pad));
}

/**
 * 把可能含换行的内容逐行刷底色（多行输入 / 粘贴的多行提交都各自撑满整行）。
 * 导出给 REPL：提交一行时把「提示符 + 输入」渲染成带底色的永久行，作为 transcript
 * 中本轮 userTurn 的一段（与输入框消失后的渲染保持一致）。
 */
export function paintInputBox(text: string, width: number): string {
  return text.split('\n').map((ln) => paintBoxLine(ln, width)).join('');
}


export interface LineEditorOpts {
  /** 输入提示符，如 chalk.blue('你 › ') */
  prompt: string;
  /** 「新 → 旧」历史，用于 ↑/↓ 翻历史 */
  history: string[];
  /** 斜杠命令元数据（名称 + 说明） */
  commands: readonly CommandMeta[];
  /** 提交一行（已 trim，非空）时回调 */
  onSubmit: (line: string) => void;
  /** Ctrl+C 等中断信号回调（由调用方决定：忙→取消，空闲→退出） */
  onInterrupt: () => void;
  /** 常驻底部状态栏（绘制输入框后顺带刷新它，保持最底行信息） */
  statusBar?: StatusBar | null;
}

type State = 'input' | 'hidden' | 'asking';

export class LineEditor {
  private readonly opts: LineEditorOpts;
  private readonly out = process.stdout;
  private readonly tty = !!process.stdin.isTTY;
  private state: State = 'input';

  // —— TTY 输入缓冲 ——
  private input = '';
  private selIndex = 0;
  /** 当前屏幕底部是否绘制着整个输入框盒子（顶边/输入/底边）。
   *  仅当为 true 时 draw/hide/commit 才向上回退清屏，避免擦到上方历史输出。 */
  private boxOnScreen = false;
  /** 当前盒子顶边所在的物理行号（1-indexed）；-1 表示盒子不在屏上。
   *  用于 hide/commit 精准清掉整盒、以及 draw 重绘时清掉可能残留的更长下拉。 */
  private boxTop = -1;

  // —— 历史导航 ——
  private histIndex = -1;
  private savedDraft = '';

  // —— 普通文本多行粘贴 debounce ——
  private pasteLines: string[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  // —— 忙时（模型生成中）排队的按键 ——
  private queued = '';

  // —— HITL 提问（y/n/a 审批）——
  private askResolve: ((v: string) => void) | null = null;
  private askBuffer = '';

  // —— readline 回退 ——
  private rl: readline.Interface | null = null;
  private resolveExit!: () => void;
  private dataHandler: ((b: Buffer) => void) | null = null;
  private resizeHandler: (() => void) | null = null;

  constructor(opts: LineEditorOpts) {
    this.opts = opts;
  }

  /** 启动编辑器，返回一个在退出（/exit、Ctrl+C 空闲、Ctrl+D）时 resolve 的 Promise */
  start(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.resolveExit = resolve;
      if (this.tty) this.startRaw();
      else this.startReadline();
    });
  }

  // ===================== TTY：raw mode 自绘 =====================

  private startRaw(): void {
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    this.dataHandler = (b) => this.onData(b);
    stdin.on('data', this.dataHandler);
    this.resizeHandler = () => this.draw();
    this.out.on('resize', this.resizeHandler);
    this.draw();
  }

  private startReadline(): void {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: this.opts.prompt,
      history: this.opts.history,
      historySize: 2000,
    });
    this.rl = rl;
    rl.on('line', (line) => {
      const t = line.trim();
      if (!t) {
        rl.prompt();
        return;
      }
      this.opts.onSubmit(t);
    });
    rl.on('close', () => this.resolveExit());
    rl.on('SIGINT', () => this.opts.onInterrupt());
    rl.prompt();
  }

  // ===================== 公开接口（供 REPL 调用） =====================

  /** 模型生成前：清掉整个输入框盒子，让输出从干净处开始 */
  hide(): void {
    if (!this.tty) return;
    const clearFrom = this.boxTop > 0 ? this.boxTop : 1;
    if (this.boxOnScreen) {
      // 从盒子顶边清到屏末，清掉整个输入框（顶边/输入/底边/菜单）
      this.out.write(`\x1b[${clearFrom};1H\x1b[J`);
      this.boxOnScreen = false;
      this.boxTop = -1;
    }
    // 盒子消失，但最底状态栏仍应保留（刷新它）
    this.opts.statusBar?.setCaret(clearFrom, 1);
    this.opts.statusBar?.render();
    // 兜底：光标回到输入框原本所在行，模型输出将从此处继续，避免落到状态栏
    this.out.write(`\x1b[${clearFrom};1H`);
    this.state = 'hidden';
  }

  /** 模型生成后：回到输入态并重绘提示符 */
  show(): void {
    if (!this.tty) return;
    this.state = 'input';
    this.out.write('\n');
    this.draw();
  }

  /** 交互式提问（权限审批 y/n/a），返回用户输入（已 trim） */
  ask(question: string): Promise<string> {
    if (!this.tty) {
      return new Promise<string>((resolve) => {
        if (!this.rl) {
          resolve('n');
          return;
        }
        this.rl.question(question, (a) => resolve(a.trim()));
      });
    }
    return new Promise<string>((resolve) => {
      this.askResolve = resolve;
      this.askBuffer = '';
      this.state = 'asking';
      this.out.write('\n' + question);
    });
  }

  /** 退出：恢复终端并 resolve start() 的 Promise */
  exit(): void {
    if (!this.tty) {
      this.rl?.close();
      this.rl = null;
      return; // 'close' 事件会触发 resolveExit
    }
    const stdin = process.stdin;
    if (this.dataHandler) stdin.removeListener('data', this.dataHandler);
    if (this.resizeHandler) this.out.removeListener('resize', this.resizeHandler);
    if (stdin.isTTY) stdin.setRawMode(false);
    stdin.pause();
    this.resolveExit();
  }

  // ===================== 渲染 =====================

  private draw(): void {
    if (!this.tty) return;
    const width = this.out.columns ?? 80;
    const dropdown = this.computeDropdown(width);
    const k = dropdown.length;
    const rows = this.out.rows ?? 24;
    const hasBar = !!this.opts.statusBar;
    // 盒子由：顶边(1) + 输入(1) + 下拉(k) + 底边(1) 组成；底边始终绘制（即便无下拉）。
    // 有常驻状态栏时最底行 rows 留给状态栏，盒子底边落在 rows-1；否则落在 rows。
    const bottom = hasBar ? rows - 1 : rows;
    const top = Math.max(1, bottom - (3 + k) + 1);
    // 清除：从「上一帧盒子顶」与「本帧盒子顶」中较高者清起，避免残留更长的下拉
    const clearFrom = this.boxTop > 0 ? Math.min(top, this.boxTop) : top;
    // 清到屏末（含状态栏行，稍后由 statusBar.render 重写）
    this.out.write(`\x1b[${clearFrom};1H\x1b[J`);
    // 逐行绝对定位绘制：不依赖 \n 前进，规避不同终端换行/自动折行差异
    // （这正是旧版「按删除键冒出多个输入框」的根因——\n 在边界处的处理不一致）。
    // 顶边横线：无底色（仅保留上沿，作为与上方 AI 输出的分隔）
    this.out.write(`\x1b[${top};1H` + '─'.repeat(width));
    // 输入行：保留输入框底色（仅这一行有底色），与上方输出区分
    this.out.write(`\x1b[${top + 1};1H` + paintBoxLine(this.opts.prompt + this.input, width));
    // 注意：不再绘制底边横线（用户要求去掉输入框下方的横线）。
    // 底边那一行（top+2）保持空白，作为输入框与最底状态栏之间的留白。
    if (k > 0) {
      for (let i = 0; i < k; i++) {
        this.out.write(`\x1b[${top + 2 + i};1H` + dropdown[i]);
      }
      // 下拉菜单也不画底边横线，保持与无下拉时一致的开放外观
    }
    // 输入框盒子绘制完成，刷新最底状态栏
    this.boxTop = top;
    const caretCol = Math.min(width, displayWidth(this.opts.prompt + this.input) + 1);
    // 让状态栏重绘后把光标送回输入行、且停在已输入文本之后（部分终端忽略 ESC[s/u）
    this.opts.statusBar?.setCaret(top + 1, caretCol);
    this.opts.statusBar?.render();
    // 兜底：状态栏禁用时 render 不处理光标；这里直接定位，确保光标一定在输入框内
    this.out.write(`\x1b[${top + 1};${caretCol}H`);
    this.boxOnScreen = true;
  }

  private filtered(): CommandMeta[] {
    if (!this.input.startsWith('/')) return [];
    const q = this.input.slice(1).toLowerCase();
    return this.opts.commands.filter((c) => c.name.toLowerCase().includes(q));
  }

  private computeDropdown(width: number): string[] {
    if (this.state !== 'input') return [];
    const matches = this.filtered();
    if (matches.length === 0) return [];
    if (this.selIndex >= matches.length) this.selIndex = matches.length - 1;
    if (this.selIndex < 0) this.selIndex = 0;

    // 预留：输入框盒子 3 行 + 最底状态栏 1 行 + 1 行缓冲
    const maxVisible = Math.min(matches.length, Math.max(2, (this.out.rows ?? 24) - 4));
    const visible = matches.slice(0, maxVisible);
    const reserved = 6 + 16 + 2; // "  /" + 名字补位 + 分隔
    const maxDesc = Math.max(8, width - reserved);

    return visible.map((c, i) => {
      const name = '/' + c.name;
      let desc = c.description;
      if (desc.length > maxDesc) desc = desc.slice(0, maxDesc - 1) + '…';
      const row = `  ${chalk.cyan(name.padEnd(16))}  ${chalk.gray(desc)}`;
      return i === this.selIndex ? chalk.inverse(row) : row;
    });
  }

  // ===================== 按键分发 =====================

  private onData(buf: Buffer): void {
    const b = buf[0] ?? 0;
    if (b === 0x03) return this.handleCtrlC(); // Ctrl+C
    if (b === 0x04) return this.handleCtrlD(); // Ctrl+D
    if (b === 0x0c) return this.handleCtrlL(); // Ctrl+L
    if (b === 0x09) return this.handleTab(); // Tab
    if (b === 0x1b) return this.handleEscape(buf); // Esc / 方向键
    if (b === 0x7f) return this.handleBackspace(); // Backspace / DEL
    if (b === 0x0d || b === 0x0a) return this.handleEnter(); // Enter
    const s = buf.toString('utf8');
    if (s && b >= 0x20) this.handlePrint(s); // 可打印（含中文多字节）
  }

  private handleCtrlC(): void {
    if (this.state === 'asking') {
      const r = this.askResolve;
      this.askResolve = null;
      this.askBuffer = '';
      this.state = 'hidden';
      r?.('n');
      return;
    }
    // 空闲（input）或忙（hidden）都交给调用方决定（退出 / 取消）
    this.opts.onInterrupt();
  }

  private handleCtrlD(): void {
    if (this.state === 'asking') {
      const r = this.askResolve;
      this.askResolve = null;
      this.state = 'hidden';
      r?.('');
      return;
    }
    if (this.state === 'hidden') return; // 忙时忽略
    this.exit();
  }

  private handleCtrlL(): void {
    if (this.state !== 'input') return;
    this.out.write('\x1b[2J\x1b[H');
    this.boxOnScreen = false; // 整屏已清，下一帧按首次绘制（不向上回退）
    this.boxTop = -1;
    this.draw();
  }

  private handleTab(): void {
    if (this.state !== 'input') return;
    if (!this.input.startsWith('/')) return;
    const m = this.filtered();
    if (m.length === 0) return;
    const sel = m[this.selIndex];
    if (!sel) return;
    this.input = '/' + sel.name + ' ';
    this.selIndex = 0;
    this.draw();
  }

  private handleEscape(buf: Buffer): void {
    if (buf.length === 1) {
      // 单独 Esc：清空输入（关闭菜单）
      if (this.state === 'input') {
        this.input = '';
        this.selIndex = 0;
        this.draw();
      }
      return;
    }
    if (buf[1] === 0x5b) {
      const c = buf[2];
      if (c === 0x41) return this.handleUp();
      if (c === 0x42) return this.handleDown();
      // 0x43 右 / 0x44 左 / 0x48 Home / 0x46 End / 0x33 Delete —— 暂忽略
    }
  }

  private handleUp(): void {
    if (this.state !== 'input') return;
    if (this.input.startsWith('/')) {
      const m = this.filtered();
      if (m.length) {
        this.selIndex = (this.selIndex - 1 + m.length) % m.length;
        this.draw();
      }
    } else {
      this.navHistory(-1);
    }
  }

  private handleDown(): void {
    if (this.state !== 'input') return;
    if (this.input.startsWith('/')) {
      const m = this.filtered();
      if (m.length) {
        this.selIndex = (this.selIndex + 1) % m.length;
        this.draw();
      }
    } else {
      this.navHistory(1);
    }
  }

  private navHistory(dir: number): void {
    const hist = this.opts.history;
    if (hist.length === 0) return;
    if (dir < 0) {
      if (this.histIndex === -1) {
        this.savedDraft = this.input;
        this.histIndex = 0;
      } else if (this.histIndex < hist.length - 1) {
        this.histIndex++;
      }
      this.input = hist[this.histIndex] ?? '';
    } else {
      if (this.histIndex === -1) return;
      if (this.histIndex > 0) {
        this.histIndex--;
        this.input = hist[this.histIndex] ?? this.savedDraft;
      } else {
        this.histIndex = -1;
        this.input = this.savedDraft;
      }
    }
    this.selIndex = 0;
    this.draw();
  }

  private handleBackspace(): void {
    if (this.state === 'asking') {
      this.askBuffer = this.askBuffer.slice(0, -1);
      this.out.write('\b \b');
      return;
    }
    if (this.state === 'hidden') {
      this.queued = this.queued.slice(0, -1);
      return;
    }
    this.input = this.input.slice(0, -1);
    this.selIndex = 0;
    this.draw();
  }

  private handlePrint(s: string): void {
    if (this.state === 'asking') {
      this.askBuffer += s;
      this.out.write(s);
      return;
    }
    if (this.state === 'hidden') {
      this.queued += s; // 忙时排队，结束后由 dispatch 顺序处理
      return;
    }
    this.input += s;
    this.selIndex = 0;
    this.draw();
  }

  private handleEnter(): void {
    if (this.state === 'asking') {
      const r = this.askResolve;
      this.askResolve = null;
      const ans = this.askBuffer;
      this.askBuffer = '';
      this.state = 'hidden';
      r?.(ans.trim());
      return;
    }
    if (this.state === 'hidden') {
      // 忙时排队：把已输入的整行送出（dispatch 会把它塞进 pending）
      if (this.queued.trim()) {
        const line = this.queued.trim();
        this.queued = '';
        this.opts.onSubmit(line);
      }
      return;
    }
    // —— 正常输入态 ——
    if (this.input.startsWith('/')) {
      const m = this.filtered();
      if (m.length > 0) {
        const sel = m[this.selIndex];
        if (!sel) return;
        const typed = this.input.slice(1).trim().toLowerCase();
        // 唯一匹配，或已精确输全名 → 直接执行
        if (m.length === 1 || typed === sel.name) {
          this.commit('/' + sel.name);
          return;
        }
        // 否则把高亮项填回输入框，继续编辑（如补子命令）
        this.input = '/' + sel.name + ' ';
        this.selIndex = 0;
        this.draw();
        return;
      }
      // 无匹配：原样提交（handleSlash 会报未知命令）
      this.commit(this.input);
      return;
    }
    // 普通文本：进入多行粘贴缓冲（短窗内到达的后续行视为同一次粘贴）
    this.pasteLines.push(this.input);
    this.input = '';
    this.selIndex = 0;
    this.draw();
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => this.flushPaste(), PASTE_DEBOUNCE_MS);
  }

  private flushPaste(): void {
    this.flushTimer = null;
    const combined = this.pasteLines.join('\n');
    this.pasteLines = [];
    if (!combined.trim()) {
      this.draw();
      return;
    }
    this.commit(combined);
  }

  /**
   * 提交一行：TTY 下把「提示符 + 输入」作为永久行写出（像 Claude Code 的「❯ 你的问题」），
   * 避免回车后输入行被清空而「消失」；随后交给调用方处理。
   * 非 TTY（readline 回退）由 readline 自己回显，无需处理。
   */
  private commit(line: string): void {
    if (this.tty) {
      // 清掉整个输入框盒子（提交后输入框不再需要边框，输入会作为永久行留在上方）
      const clearFrom = this.boxTop > 0 ? this.boxTop : 1;
      if (this.boxOnScreen) {
        this.out.write(`\x1b[${clearFrom};1H\x1b[J`);
        this.boxOnScreen = false;
        this.boxTop = -1;
      }
      // 把输入回显为永久行（整行带输入框底色，撑满终端宽度；多行粘贴逐行刷底色）
      const width = this.out.columns ?? 80;
      this.out.write(paintInputBox(this.opts.prompt + line, width) + '\n');
      this.state = 'hidden';
      // 提交后刷新最底状态栏
      const afterRow = clearFrom + (this.opts.prompt + line).split('\n').length;
      this.opts.statusBar?.setCaret(afterRow, 1);
      this.opts.statusBar?.render();
      // 兜底：光标移到提交行下一行，模型输出将从此处开始，避免落到状态栏
      this.out.write(`\x1b[${afterRow};1H`);
    }
    this.opts.onSubmit(line);
  }
}
