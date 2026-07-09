import chalk from 'chalk';

/**
 * 手写「Markdown → 终端 ANSI」渲染器（无任何第三方依赖，契合项目「纯手写」原则）。
 *
 * 把模型回复里的常见 Markdown 语法渲染成终端里好看的效果：
 *   标题(# ~ ######)、粗体(**)、斜体(*)、行内代码(`)、代码块(```)、有序/无序列表、
 *   引用(>)、分隔线(---/***)、链接([t](url))、删除线(~~)、
 *   GFM 表格(| a | b | + 分隔行)、任务列表(- [ ] / - [x])、图片(![alt](url) 退化为 alt)、
 *   裸 URL 自动链接(http/https)、反斜杠转义(\* \_ 等不触发样式)。
 *
 * 设计要点：
 *   - 按「显示宽度」折行（CJK/全角按 2 列），避免中文被从字中间截断；
 *   - 先对「纯文本」计算折行，再对每一行单独施加行内样式 —— 样式永远不会跨行溢出
 *     （否则未闭合的 ANSI 会污染下方内容）；
 *   - 不含 `_` 的斜体/粗体判定（避免 `snake_case` 被误渲染）；
 *   - 返回「每一屏显行」组成的数组，行内不含 `\n`，方便调用方按行数精准管理自绘区域。
 *
 * 典型用法（在 StatusLine 里）：renderMarkdown(body, width) → string[]
 */

/** 去掉 ANSI 转义，用于计算纯显示宽度 */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

/** 单个码点是否为「宽字符」（CJK / 全角等，占 2 列） */
function isWide(code: number): boolean {
  return (
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
    (code >= 0x20000 && code <= 0x3fffd) // CJK 扩展 B+
  );
}

/** 一个字符串的显示宽度（忽略 ANSI，CJK 按 2） */
function dispWidth(s: string): number {
  let w = 0;
  for (const ch of stripAnsi(s)) {
    w += isWide(ch.codePointAt(0) ?? 0) ? 2 : 1;
  }
  return w;
}

/**
 * 把「纯文本」按显示宽度折行（不施加任何样式）。
 * CJK 单字成词（可在任意字间断行），latin 连续非空白成词，超长单词硬断。
 * @param indent 续行缩进的空格数（不含首行）
 */
function wrap(text: string, width: number, indent = 0): string[] {
  const max = Math.max(1, width - indent);
  const tokens = text.match(/[㐀-鿿一-鿿]|[^\s㐀-鿿一-鿿]+|\s+/g) ?? [text];
  const lines: string[] = [];
  let cur = '';
  let curW = 0;

  const pushCur = () => {
    lines.push(cur);
    cur = '';
    curW = 0;
  };

  for (const tok of tokens) {
    const tw = dispWidth(tok);
    if (tw > max) {
      // 超长 token（如长 URL）：逐字硬断
      let rest = tok;
      while (dispWidth(rest) > max) {
        let cut = 0;
        let w = 0;
        while (cut < rest.length) {
          const cw = dispWidth(rest[cut] ?? '');
          if (w + cw > max) break;
          w += cw;
          cut++;
        }
        if (curW > 0) pushCur();
        lines.push(rest.slice(0, cut));
        rest = rest.slice(cut);
      }
      cur = rest;
      curW = dispWidth(rest);
      continue;
    }
    if (curW + tw > max && curW > 0) pushCur();
    cur += tok;
    curW += tw;
  }
  if (cur) lines.push(cur);
  return lines;
}

/**
 * 与 wrap 类似，但输入已带 ANSI 样式（`inline()` 的结果）。
 * 关键：当折行把「一个样式跨行截断」时，在行尾补 `\x1b[0m` 关闭、下一行行首按当前
 * 打开的样式栈（如 `\x1b[1m`）重新打开 —— 这样粗体/斜体跨行也连续，且不会污染下方内容。
 */
function wrapStyled(text: string, width: number, indent = 0): string[] {
  const max = Math.max(1, width - indent);
  const tokens =
    text.match(/\x1b\[[0-9;]*m|[\u4e00-\u9fff\u3400-\u4dbf]|[^\s\u4e00-\u9fff\u3400-\u4dbf]+|\s+/g) ??
    [text];
  const lines: string[] = [];
  let cur = '';
  let curW = 0;
  let open: string[] = []; // 当前处于打开状态的 ANSI 样式码（如 \x1b[1m）

  const breakLine = () => {
    if (open.length) cur += '\x1b[0m';
    lines.push(cur);
    cur = open.join('');
    curW = 0;
  };

  for (const tok of tokens) {
    if (tok.startsWith('\x1b[')) {
      if (tok === '\x1b[0m') open = [];
      else open.push(tok);
      cur += tok;
      continue;
    }
    const tw = dispWidth(tok);
    if (tw > max) {
      // 超长 token（如长 URL / 无空格长串）：逐字硬断并维持样式
      for (const ch of tok) {
        const cw = dispWidth(ch);
        if (curW + cw > max && curW > 0) breakLine();
        cur += ch;
        curW += cw;
      }
      continue;
    }
    if (curW + tw > max && curW > 0) {
      // 当前词/串放不下：在它之前换行（行首的纯空白直接丢弃）
      breakLine();
      if (tok.trim() === '') continue; // 丢弃行首空格
    }
    cur += tok;
    curW += tw;
  }
  if (cur) {
    if (open.length) cur += '\x1b[0m';
    lines.push(cur);
  }
  return lines;
}

/** 行内样式：`**粗**`、`*斜*`、`` `代码` ``、`[文字](url)`、`~~删除~~`、转义、`![alt](url)`、裸 URL */
function inline(text: string): string {
  let out = '';
  let i = 0;
  const n = text.length;
  // 需要被反斜杠转义的字面字符（避免被当成 Markdown 语法渲染）
  const ESCAPE = '\\`*_{}[]()#+-.!~>|';
  while (i < n) {
    const c = text[i];
    // 转义：\X -> 字面 X（如 \* 显示为星号，不被当斜体/粗体）
    if (c === '\\' && i + 1 < n && ESCAPE.includes(text[i + 1] ?? '')) {
      out += text[i + 1] ?? '';
      i += 2;
      continue;
    }
    // 图片 ![alt](url)：终端无法显示图片，渲染为 alt 文本（灰）
    if (c === '!' && text[i + 1] === '[') {
      const m = /^!\[([^\]]*)\]\(([^)]+)\)/.exec(text.slice(i));
      if (m) {
        out += chalk.gray(m[1] ?? '');
        i += m[0].length;
        continue;
      }
    }
    // 链接 [文字](url)
    if (c === '[') {
      const m = /^\[([^\]]*)\]\(([^)]+)\)/.exec(text.slice(i));
      if (m) {
        out += chalk.cyan.underline(inline(m[1] ?? ''));
        i += m[0].length;
        continue;
      }
    }
    // 裸 URL 自动链接（http/https）
    if (c === 'h' && (text.startsWith('https://', i) || text.startsWith('http://', i))) {
      const m = /^(https?:\/\/[^\s)]+)/.exec(text.slice(i));
      if (m) {
        out += chalk.cyan.underline(m[1] ?? '');
        i += (m[1] ?? '').length;
        continue;
      }
    }
    // 行内代码
    if (c === '`') {
      const end = text.indexOf('`', i + 1);
      if (end !== -1) {
        out += chalk.cyan(text.slice(i + 1, end));
        i = end + 1;
        continue;
      }
    }
    // 粗体 **
    if (c === '*' && text[i + 1] === '*') {
      const end = text.indexOf('**', i + 2);
      if (end !== -1) {
        out += chalk.bold(inline(text.slice(i + 2, end)));
        i = end + 2;
        continue;
      }
    }
    // 删除线 ~~
    if (c === '~' && text[i + 1] === '~') {
      const end = text.indexOf('~~', i + 2);
      if (end !== -1) {
        out += chalk.strikethrough(inline(text.slice(i + 2, end)));
        i = end + 2;
        continue;
      }
    }
    // 斜体 *（要求两侧非空格，避免 `2 * 3` 被误判）
    if (c === '*' && text[i + 1] !== '*' && text[i + 1] !== ' ' && i + 1 < n) {
      const end = text.indexOf('*', i + 1);
      if (end !== -1 && end > i + 1 && text[end - 1] !== ' ') {
        out += chalk.italic(inline(text.slice(i + 1, end)));
        i = end + 1;
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

function styleHeading(text: string, level: number): string {
  const inner = inline(text);
  if (level === 1) return chalk.bold.cyan(inner);
  if (level === 2) return chalk.bold(inner);
  return chalk.bold(chalk.gray(inner));
}

function renderCode(code: string[], lang: string, width: number): string[] {
  const out: string[] = [];
  out.push(chalk.gray('─'.repeat(width)));
  if (lang) out.push(chalk.gray(`λ ${lang}`));
  for (const raw of code) {
    for (const ln of wrap(raw, width - 2)) {
      out.push('  ' + chalk.cyan(ln));
    }
  }
  out.push(chalk.gray('─'.repeat(width)));
  return out;
}

function renderList(
  items: { indent: number; ordered: boolean; num: number; text: string }[],
  width: number,
): string[] {
  const out: string[] = [];
  for (const it of items) {
    const base = Math.floor(it.indent / 2) * 2;
    // 任务列表：- [ ] / - [x] / - [X]
    const cb = /^\[([ xX])\]\s+(.*)$/.exec(it.text);
    let marker = it.ordered ? `${it.num}.` : '•';
    let text = it.text;
    if (cb) {
      const checked = cb[1] !== ' ';
      marker = checked ? '☑' : '☐';
      text = cb[2] ?? '';
    }
    const mw = dispWidth(marker);
    const contIndent = base + mw + 1;
    const wrapped = wrapStyled(inline(text), Math.max(1, width - contIndent));
    wrapped.forEach((ln, idx) => {
      const pad = ' '.repeat(idx === 0 ? base : contIndent);
      const prefix = idx === 0 ? chalk.cyan(marker) + ' ' : '';
      out.push(pad + prefix + ln);
    });
  }
  return out;
}

// ===================== 表格 =====================

/** 解析一行表格为单元格数组（容忍首尾的 |）；不是表格行返回 null */
function parseTableRow(line: string): string[] | null {
  const t = line.trim();
  if (!t.includes('|')) return null;
  let inner = t;
  if (inner.startsWith('|')) inner = inner.slice(1);
  if (inner.endsWith('|')) inner = inner.slice(0, -1);
  if (inner.length === 0) return null;
  return inner.split('|').map((c) => c.trim());
}

/** 表格分隔行：每个单元格都是 `:?-+:?` 形式 */
function isTableSep(line: string): boolean {
  const cells = parseTableRow(line);
  if (!cells || cells.length === 0) return false;
  return cells.every((c) => /^:?-+:?$/.test(c.trim()));
}

/** 是否像一行表格（≥2 列） */
function isTableRow(line: string): boolean {
  const cells = parseTableRow(line);
  return !!cells && cells.length >= 2;
}

type Align = 'l' | 'c' | 'r';

/**
 * 把 GFM 表格渲染成终端 ASCII 表格（┌─┬─┐ 风格），支持对齐与单元格内折行。
 * @param rows 原始表格行（含可能的分隔行）
 */
function renderTable(rows: string[], width: number): string[] {
  const grid = rows.map((r) => parseTableRow(r) ?? []);
  const cols = Math.max(...grid.map((r) => r.length));
  grid.forEach((r) => {
    while (r.length < cols) r.push('');
  });

  // 对齐方式取自分隔行（第 2 行若为分隔）
  const aligns: Align[] = new Array(cols).fill('l');
  let sepIdx = -1;
  if (grid.length >= 2 && isTableSep(rows[1] ?? '')) {
    sepIdx = 1;
    const sep = grid[1] ?? [];
    for (let c = 0; c < cols; c++) {
      const cell = (sep[c] ?? '').trim();
      if (cell.startsWith(':') && cell.endsWith(':')) aligns[c] = 'c';
      else if (cell.endsWith(':')) aligns[c] = 'r';
      else if (cell.startsWith(':')) aligns[c] = 'l';
    }
  }

  // 内容行（去掉分隔行）
  const body = grid.filter((_, i) => i !== sepIdx);

  // 每列最大内容显示宽度（含表头）
  const colW: number[] = new Array(cols).fill(0);
  for (let c = 0; c < cols; c++) {
    let max = 0;
    for (const row of body) max = Math.max(max, dispWidth(row[c] ?? ''));
    colW[c] = max;
  }

  // 总宽 = 边框(cols+1) + 每列(内容+左右各1空格)
  const avail = Math.max(cols * 3 + 1, width);
  let scale = 1;
  const contentTotal = colW.reduce((a, b) => a + b + 2, 0);
  if (cols + 1 + contentTotal > avail) {
    // 等比缩小内容区，至少保留 3 列宽
    const room = avail - (cols + 1);
    const sum = colW.reduce((a, b) => a + b, 0);
    scale = sum > 0 ? Math.max(0.1, (room - cols * 2) / sum) : 1;
  }
  for (let c = 0; c < cols; c++) colW[c] = Math.max(3, Math.floor((colW[c] ?? 0) * scale));

  const out: string[] = [];
  const top = '┌' + colW.map((w) => '─'.repeat(w + 2)).join('┬') + '┐';
  const mid = '├' + colW.map((w) => '─'.repeat(w + 2)).join('┼') + '┤';
  const bot = '└' + colW.map((w) => '─'.repeat(w + 2)).join('┴') + '┘';

  const drawRow = (cells: string[], header: boolean) => {
    const cellLines: string[][] = cells.map((cell, c) => {
      const wlines = wrapStyled(inline(cell), colW[c] ?? 0);
      return wlines.length ? wlines : [''];
    });
    const n = Math.max(1, ...cellLines.map((l) => l.length));
    for (let r = 0; r < n; r++) {
      let line = '';
      for (let c = 0; c < cols; c++) {
        const content = cellLines[c]?.[r] ?? '';
        const cw = dispWidth(stripAnsi(content));
        // 内容区总宽 = 内容最大宽 + 2（单元格内左右各留 1 空格，与边框 ─ 宽度一致）
        const pad = Math.max(0, (colW[c] ?? 0) - cw) + 2;
        const al = aligns[c] ?? 'l';
        let left = 1;
        let right = pad - 1;
        if (al === 'r') {
          left = pad - 1;
          right = 1;
        } else if (al === 'c') {
          left = Math.floor(pad / 2);
          right = pad - left;
        }
        line += '│' + ' '.repeat(Math.max(0, left)) + content + ' '.repeat(Math.max(0, right));
      }
      line += '│';
      out.push(header ? chalk.bold(line) : line);
    }
  };

  out.push(top);
  if (body.length) drawRow(body[0] ?? [], true);
  if (sepIdx >= 0) out.push(mid);
  for (let r = 1; r < body.length; r++) drawRow(body[r] ?? [], false);
  out.push(bot);
  return out;
}

/**
 * 把 Markdown 源文本渲染为终端 ANSI 行数组。
 * @param width 终端宽度（列数），用于折行
 * @returns 每一屏显行（无前导/尾随空行，行内不含 `\n`）
 */
export function renderMarkdown(src: string, width: number): string[] {
  const w = Math.max(20, width);
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? '';

    // 代码块 ```lang ... ```
    const fence = /^(\s*)```(.*)$/.exec(line);
    if (fence) {
      const lang = (fence[2] ?? '').trim();
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i] ?? '')) {
        code.push(lines[i] ?? '');
        i++;
      }
      i++; // 跳过收尾的 ```
      out.push(...renderCode(code, lang, w));
      continue;
    }

    // 标题 # ~ ######
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const level = (h[1] ?? '').length;
      const raw = (h[2] ?? '').trim();
      for (const ln of wrapStyled(styleHeading(raw, level), w)) out.push(ln);
      if (level <= 2) out.push(chalk.gray('─'.repeat(Math.min(w, 40))));
      i++;
      continue;
    }

    // 分隔线
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push(chalk.gray('─'.repeat(w)));
      i++;
      continue;
    }

    // 引用 >
    if (/^\s*>/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i] ?? '')) {
        quote.push((lines[i] ?? '').replace(/^\s*>\s?/, ''));
        i++;
      }
      for (const l of renderMarkdown(quote.join('\n'), w - 2)) {
        out.push(chalk.gray('│ ') + chalk.gray(l));
      }
      continue;
    }

    // 表格（GFM：当前行像表格行且以 | 起始，或与分隔行相邻）
    if (isTableRow(line) && (/^\s*\|/.test(line) || isTableSep(line))) {
      const tableLines: string[] = [];
      while (i < lines.length && isTableRow(lines[i] ?? '')) {
        tableLines.push(lines[i] ?? '');
        i++;
      }
      out.push(...renderTable(tableLines, w));
      continue;
    }

    // 列表（有序 / 无序，连续直到空行或块级元素）
    const ul = /^(\s*)([-*+])\s+(.*)$/.exec(line);
    const ol = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line);
    if (ul || ol) {
      const items: { indent: number; ordered: boolean; num: number; text: string }[] = [];
      while (i < lines.length) {
        const u = /^(\s*)([-*+])\s+(.*)$/.exec(lines[i] ?? '');
        const o = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(lines[i] ?? '');
        if (u) {
          items.push({ indent: (u[1] ?? '').length, ordered: false, num: 0, text: u[3] ?? '' });
          i++;
        } else if (o) {
          items.push({
            indent: (o[1] ?? '').length,
            ordered: true,
            num: parseInt(o[2] ?? '0', 10),
            text: o[3] ?? '',
          });
          i++;
        } else if ((lines[i] ?? '').trim() === '') {
          i++;
          break;
        } else {
          break;
        }
      }
      out.push(...renderList(items, w));
      continue;
    }

    // 空行
    if (line.trim() === '') {
      i++;
      continue;
    }

    // 段落：收集到下一个块级元素或空行
    const para: string[] = [];
    while (
      i < lines.length &&
      (lines[i] ?? '').trim() !== '' &&
      !/^(\s*)```/.test(lines[i] ?? '') &&
      !/^(#{1,6})\s+/.test(lines[i] ?? '') &&
      !/^\s*>/.test(lines[i] ?? '') &&
      !/^\s*([-*+])\s+/.test(lines[i] ?? '') &&
      !/^\s*(\d+)[.)]\s+/.test(lines[i] ?? '') &&
      !/^\s*([-*_])(\s*\1){2,}\s*$/.test(lines[i] ?? '')
    ) {
      para.push(lines[i] ?? '');
      i++;
    }
    const text = para.join(' ').trim();
    if (text) {
      for (const ln of wrapStyled(inline(text), w)) out.push(ln);
    }
  }

  // 去掉首尾空行，避免上方/下方多出空隙
  while (out.length && dispWidth(stripAnsi(out[0] ?? '')) === 0) out.shift();
  while (out.length && dispWidth(stripAnsi(out[out.length - 1] ?? '')) === 0) out.pop();
  return out;
}
