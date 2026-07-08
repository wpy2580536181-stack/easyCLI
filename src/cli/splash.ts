// 启动欢迎面板（Splash / Banner）。
//
// 在 REPL 进入交互循环前打印一段品牌信息块，参考 Claude Code / PaiCLI 的启动 banner：
//   - 第 1 行：项目名@版本 + 项目名 + 工作目录
//   - 第 2 行：运行方式（dev=tsx 直接跑 TS / build=node 跑 dist 产物）
//   - 第 3 行：装饰横幅（色块 + 名称 + 版本号）
//   - 第 4 行：运行信息（当前模型 / git 分支），帮助用户一眼确认「我在哪、用什么模型」
//
// 信息密度高但不刷屏（约 4 行），全部用 chalk 着色。项目元信息从 package.json 读取
// （用 createRequire，与 Phase 4 读 SQLite 同范式，避免依赖 resolveJsonModule）。

import chalk from 'chalk';
import { createRequire } from 'node:module';
import { gatherContext } from '../core/prompts/context';
import { ui } from './theme';

const require = createRequire(import.meta.url);
let pkg: { name?: string; version?: string };
try {
  pkg = require('../../package.json') as { name?: string; version?: string };
} catch {
  pkg = {};
}

export interface SplashOptions {
  /** 工作目录（默认 process.cwd()） */
  cwd?: string;
  /** 是否开发模式运行（tsx 直接跑 TS vs node 跑 dist 产物） */
  isDev?: boolean;
  /** 当前模型 id，显示在信息行（如 openai:deepseek-chat） */
  modelId?: string;
}

/**
 * 渲染并打印启动欢迎面板。
 */
export function printSplash(opts: SplashOptions = {}): void {
  const name = pkg.name ?? 'agent-cli';
  const version = pkg.version ?? '0.0.0';
  const cwd = opts.cwd ?? process.cwd();
  const isDev = opts.isDev ?? true;
  const ctx = gatherContext(cwd); // 复用动态上下文采集，取 git 分支（失败静默降级）

  // ── 第 1 行：项目标识 + 工作目录 ─────────────────────────────────────────────
  console.log(
    chalk.gray('> ') +
      chalk.cyan(`${name}@${version}`) +
      chalk.white(' ') +
      ui.primary(name) +
      chalk.white(' ') +
      chalk.white(cwd),
  );

  // ── 第 2 行：运行方式 ────────────────────────────────────────────────────────
  const cmd = isDev ? 'tsx src/cli/main.ts' : 'node dist/cli/main.js';
  console.log(chalk.gray(`> ${cmd}`));

  // ── 第 3 行：装饰横幅（色块 + 品牌 + 版本）────────────────────────────────────
  const block = chalk.bgCyan('    ');
  console.log(
    '\n' +
      block +
      '  ' +
      chalk.bold.white('easyCLI') +
      ' ' +
      chalk.yellow('⚡') +
      ' ' +
      chalk.gray(`v${version}`) +
      '\n',
  );

  // ── 第 4 行：运行信息（模型 / git 分支）─────────────────────────────────────
  const info: string[] = [];
  if (opts.modelId) {
    info.push(chalk.gray('📦 模型: ') + chalk.cyan(opts.modelId));
  }
  if (ctx.gitBranch) {
    info.push(chalk.gray('🌿 分支: ') + ui.primary(ctx.gitBranch));
  }
  if (info.length) console.log(info.join('   '));
}
