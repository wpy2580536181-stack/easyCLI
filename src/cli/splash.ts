// 启动欢迎面板（Splash / Banner）。
//
// 进入交互循环前打印一段品牌信息块，参考 Claude Code 的双栏框 + PaiCLI 的极客感：
//   - 顶边：方角框（┌─…─┐），品牌大字标题由 React <SplashTitle> 头部承担（ink-big-text 渐变）
//   - 左栏：欢迎语 + 运行信息（Model / CWD / Branch / Engine / Tools / Skills·MCP）
//   - 右栏：能力速览（ReAct / Plan / MCP / RAG / Memory / Multi-Agent）
//   - 底边：操作提示（方角框 └─…─┘）
//
// 边框统一为方角 Unicode box-drawing（┌─┐│└┘），与 markdown 表格风格一致（见 theme.ts 的 ui.border）。
//
// 内宽按终端列数自适应并 clamp 到 [70,90]，用 displayWidth 计算填充（CJK 宽度已处理）。
// 返回打印出来的「屏显行」数组，供 REPL 收集进 transcript 作为首屏历史，状态行动画
// 从顶行重绘时不会被吞掉。

import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { gatherContext } from '../core/prompts/context';
import { ui } from './theme';

const require = createRequire(import.meta.url);
let pkg: { name?: string; version?: string };
try {
  pkg = require('../../package.json') as { name?: string; version?: string };
} catch {
  pkg = {};
}

/** 视觉宽度（忽略 ANSI 转义；CJK/全角字符按 2 计） */
function dw(s: string): number {
  const strip = s.replace(/\x1b\[[0-9;]*m/g, '');
  let w = 0;
  for (const ch of strip) w += ch.charCodeAt(0) > 0x2e80 ? 2 : 1;
  return w;
}

/** 右侧补空格到视觉宽度 n（内容超宽则按可见宽度截断，避免撑破框线导致 Ink 换行） */
function padTo(s: string, n: number): string {
  const w = dw(s);
  if (w >= n) return truncateVis(s, n);
  return s + ' '.repeat(n - w);
}

/** 在宽度 n 内居中（奇数差分补到右侧；超宽则截断） */
function center(s: string, n: number): string {
  const w = dw(s);
  if (w >= n) return truncateVis(s, n);
  const left = Math.floor((n - w) / 2);
  return ' '.repeat(left) + s + ' '.repeat(n - w - left);
}

/**
 * 按「可见宽度」截断字符串（CJK 计 2），保留 ANSI 转义码完整性：
 * 遍历原串，遇 `\x1b[...m` 整段复制且不占预算；普通字符按 dw 占预算；
 * 预算耗尽即停，并在末尾补 `\x1b[0m` 防止颜色泄漏到下一格。
 */
function truncateVis(s: string, n: number): string {
  let used = 0;
  let out = '';
  let i = 0;
  while (i < s.length) {
    if (s[i] === '\x1b') {
      const m = s.indexOf('m', i);
      if (m === -1) break;
      out += s.slice(i, m + 1);
      i = m + 1;
      continue;
    }
    const ch = s[i];
    if (ch === undefined) break;
    const cw = ch.charCodeAt(0) > 0x2e80 ? 2 : 1;
    if (used + cw > n) break;
    out += ch;
    used += cw;
    i += 1;
  }
  // 若截断发生在着色区间内，补 reset 收尾。
  if (/\x1b\[[0-9;]*m/.test(out) && !out.endsWith('\x1b[0m')) out += '\x1b[0m';
  return out;
}

export interface SplashOptions {
  /** 工作目录（默认 process.cwd()） */
  cwd?: string;
  /** 是否开发模式运行（保留兼容，当前 banner 未使用） */
  isDev?: boolean;
  /** 当前模型 id，显示在信息行（如 openai:agnes-2.0-flash） */
  modelId?: string;
  /** 内置 + 技能工具总数（显示在信息行 Tools） */
  toolCount?: number;
  /** 已加载技能总数（显示在信息行 Skills） */
  skillCount?: number;
  /** 已连接 MCP server 总数（显示在信息行 MCP） */
  mcpCount?: number;
}

/**
 * 渲染并打印启动欢迎面板（双栏圆角框）。返回打印出来的「屏显行」数组，供调用方
 * （REPL）收集进 transcript，作为状态行动画从顶行重绘时的「历史正文」。
 */
/**
 * 纯渲染：计算并返回 Splash 屏显行，不打印。供 Ink/TTY 路径把首屏收进
 * store.initialTranscript（由 Transcript 组件渲染一次），避免与 console.log 重复成两个框。
 */
export function renderSplash(opts: SplashOptions = {}): string[] {
  const version = pkg.version ?? '0.0.0';
  const cwdRaw = opts.cwd ?? process.cwd();
  const cwd = cwdRaw.replace(homedir(), '~');
  const ctx = gatherContext(cwdRaw); // 复用动态上下文采集，取 git 分支（失败静默降级）
  const model = opts.modelId ?? 'unknown';

  // 盒子外宽（含左右方角 ┌ ┐ 两列）= W。
  // ⚠ 关键约束：W 必须严格 < cols（至少留 1 列余量）。
  // 若 W == cols，整条框线正好占满终端「最后一列」，多数终端在写满末列后会自动
  // 换到下一行（auto-wrap at last column）→ 顶/底边框被拆成多行。这正是真机 70~90 列
  // 复现「┌ / 长横 / ┐ 三行」的根因；而 ink-testing-library 写死 100 列（有富余）复现不出。
  // 因此这里留 2 列余量（左右各 ≥1），上限仍 clamp 到 90，下限 20 防退化。
  const cols = process.stdout.columns ?? 80;
  const W = Math.max(20, Math.min(90, cols - 2));
  // 主体行 = 左竖线(1) + 左栏(LW) + 中竖线(1) + 右栏(RW) + 右竖线(1) = W
  // ⇒ LW + RW = W - 3。顶/底行 = ┌ + ─×(W-2) + ┐ = W。
  const LW = Math.floor((W - 3) / 2); // 左栏内容宽
  const RW = W - 3 - LW; // 右栏内容宽

  // 整框水平居中：终端比框宽时框会贴左，与居中大标题错位。按 (cols - W)/2 左补空格，
  // 让框与大标题用同一居中基准（均参照 process.stdout.columns）。
  const padLeft = Math.max(0, Math.floor((cols - W) / 2));
  const pad = ' '.repeat(padLeft);

  const border = ui.border; // 边框 / 分隔线统一色（见 theme.ts 的 ui.border）

  // ── 顶边：纯方角框（品牌大字标题由 React <SplashTitle> 头部渲染，避免 TTY 下 ANSI 被 Ink 剥离）──
  // 外宽严格 = W：方角各占 1 列，中间横线 W-2 根。
  const top = '┌' + border('─'.repeat(W - 2)) + '┐';

  // ── 左栏：欢迎 + 运行信息 ───────────────────────────────────────────────────
  // 层级：区块标题 primary(bold) > 数据值 value(白) > 字段标签 muted(灰)。
  const left = [
    center(ui.primary.bold('Welcome back!'), LW),
    padTo(ui.muted('Model   ') + ui.value(model), LW),
    padTo(ui.muted('CWD     ') + ui.value(cwd), LW),
    padTo(ui.muted('Branch  ') + ui.value(ctx.gitBranch ?? '-'), LW),
    padTo(ui.muted('Engine  ') + ui.value('ReAct loop'), LW),
    padTo(ui.muted('Tools   ') + ui.value(String(opts.toolCount ?? 0)), LW),
    padTo(ui.muted('Skills  ') + ui.value(`${opts.skillCount ?? 0} · MCP ${opts.mcpCount ?? 0}`), LW),
  ];

  // ── 右栏：能力速览 ──────────────────────────────────────────────────────────
  const caps = [
    'ReAct loop + Tool Calling',
    'Plan mode (plan + parallel)',
    'MCP protocol (client/server)',
    'RAG: TF-IDF + vector store',
    'Memory: compress + long-term',
    'Multi-Agent collaboration',
  ];
  const right: string[] = [center(ui.primary.bold('Capabilities'), RW)];
  for (const c of caps) right.push(padTo(ui.accent('• ') + ui.value(c), RW));
  // 两栏等高：短的一侧用空行补齐
  while (right.length < left.length) right.push(padTo('', RW));
  while (left.length < right.length) left.push(padTo('', LW));

  // ── 底边：纯方角框（与顶边对称，外宽 = W） ─────────────────────────────────
  const bottom = '└' + border('─'.repeat(W - 2)) + '┘';

  // 操作提示放在框外单独一行并居中，让上下边框保持对称，避免顶边空、底边厚的视觉失衡。
  const hint = 'type a question to begin · /help for commands · Ctrl+C to abort';
  const hintLine = center(ui.muted(hint), W);

  // ── 组装：框体 + 外部提示 + 呼吸空行（整框左补 pad 以水平居中） ──────────────
  const lines: string[] = [pad + top];
  for (let i = 0; i < left.length; i++) {
    lines.push(pad + '│' + left[i] + border('│') + right[i] + '│');
  }
  lines.push(pad + bottom);
  lines.push(pad + hintLine);
  lines.push(''); // 与后续输入框之间的呼吸空行

  return lines;
}

/**
 * 打印版：在 renderSplash 基础上直接 console.log 到真实终端，再返回行。
 * 供非 TTY（纯文本 / 管道）路径使用——那里没有 Ink 状态栏重绘，需直接打印首屏。
 */
export function printSplash(opts: SplashOptions = {}): string[] {
  const lines = renderSplash(opts);
  lines.forEach((l) => console.log(l));
  return lines;
}
