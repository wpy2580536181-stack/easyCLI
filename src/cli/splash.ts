// 启动欢迎面板（Splash / Banner）。
//
// 进入交互循环前打印一段品牌信息块，参考 Claude Code 的双栏圆角框 + PaiCLI 的极客感：
//   - 顶边：居中标题 ` easyCLI vX `（圆角边框 ╭─…─╮）
//   - 左栏：欢迎语 + 标识 + 运行信息（Model / CWD / Branch / Engine / Built）
//   - 右栏：能力速览（ReAct / Plan / MCP / RAG / Memory / Multi-Agent）
//   - 底边：操作提示（圆角边框 ╰─…─╯）
//
// 内宽按终端列数自适应并 clamp 到 [70,90]，用 displayWidth 计算填充（CJK 宽度已处理）。
// 返回打印出来的「屏显行」数组，供 REPL 收集进 transcript 作为首屏历史，状态行动画
// 从顶行重绘时不会被吞掉。

import chalk from 'chalk';
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

/** 右侧补空格到视觉宽度 n */
function padTo(s: string, n: number): string {
  const d = Math.max(0, n - dw(s));
  return s + ' '.repeat(d);
}

/** 在宽度 n 内居中（奇数差分补到右侧） */
function center(s: string, n: number): string {
  const w = dw(s);
  if (w >= n) return s;
  const left = Math.floor((n - w) / 2);
  return ' '.repeat(left) + s + ' '.repeat(n - w - left);
}

export interface SplashOptions {
  /** 工作目录（默认 process.cwd()） */
  cwd?: string;
  /** 是否开发模式运行（保留兼容，当前 banner 未使用） */
  isDev?: boolean;
  /** 当前模型 id，显示在信息行（如 openai:agnes-2.0-flash） */
  modelId?: string;
}

/**
 * 渲染并打印启动欢迎面板（双栏圆角框）。返回打印出来的「屏显行」数组，供调用方
 * （REPL）收集进 transcript，作为状态行动画从顶行重绘时的「历史正文」。
 */
export function printSplash(opts: SplashOptions = {}): string[] {
  const version = pkg.version ?? '0.0.0';
  const brand = 'easyCLI'; // 项目对外品牌（package.json 的 name 是 agent-cli，仅作 npm 包名）
  const cwdRaw = opts.cwd ?? process.cwd();
  const cwd = cwdRaw.replace(homedir(), '~');
  const ctx = gatherContext(cwdRaw); // 复用动态上下文采集，取 git 分支（失败静默降级）
  const model = opts.modelId ?? 'unknown';

  // 盒子内宽（两外竖线之间）：clamp 到 [70,90]，窄终端不溢出
  const cols = process.stdout.columns ?? 80;
  const W = Math.min(90, Math.max(70, cols));
  const LW = Math.floor((W - 1) / 2); // 左栏内容宽
  const RW = W - 1 - LW; // 右栏内容宽（LW + 1 分隔线 + RW = W）

  const border = ui.muted; // 边框 / 分隔线颜色（灰）

  // ── 顶边：标题居中 ──────────────────────────────────────────────────────────
  const title = ` ${brand} v${version} `;
  const tw = dw(title);
  const tb = Math.floor((W - tw) / 2);
  const ta = W - tw - tb;
  const top =
    '╭' + border('─'.repeat(tb)) + ui.primary.bold(title) + border('─'.repeat(ta)) + '╮';

  // ── 左栏：欢迎 + 运行信息 ───────────────────────────────────────────────────
  const left = [
    center(ui.primary.bold('Welcome back!'), LW),
    center(chalk.yellow('✦') + ' ' + ui.primary('easyCLI') + ' ' + chalk.yellow('✦'), LW),
    padTo(ui.muted('Model   ') + chalk.white(model), LW),
    padTo(ui.muted('CWD     ') + chalk.white(cwd), LW),
    padTo(ui.muted('Branch  ') + ui.primary(ctx.gitBranch ?? '-'), LW),
    padTo(ui.muted('Engine  ') + chalk.white('ReAct loop'), LW),
    padTo(ui.muted('Built   ') + chalk.white('from-scratch CLI'), LW),
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
  const right: string[] = [padTo(ui.primary.bold('Capabilities'), RW)];
  for (const c of caps) right.push(padTo(ui.primary('• ') + chalk.white(c), RW));
  // 两栏等高：短的一侧用空行补齐
  while (right.length < left.length) right.push(padTo('', RW));
  while (left.length < right.length) left.push(padTo('', LW));

  // ── 底边：操作提示 ─────────────────────────────────────────────────────────
  const hint = ' type a question to begin · /help for commands · Ctrl+C to abort ';
  const hw = dw(hint);
  const hb = Math.max(1, Math.floor((W - hw) / 2));
  const ha = W - hw - hb;
  const bottom = '╰' + border('─'.repeat(hb)) + hint + border('─'.repeat(ha)) + '╯';

  // ── 组装 ───────────────────────────────────────────────────────────────────
  const lines: string[] = [top];
  for (let i = 0; i < left.length; i++) {
    lines.push('│' + left[i] + border('│') + right[i] + '│');
  }
  lines.push(bottom);

  lines.forEach((l) => console.log(l));
  return lines;
}
