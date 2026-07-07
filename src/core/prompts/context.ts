// Phase 13：动态上下文采集（系统提示的运行环境注入）。
//
// 把「当前时间 / 工作目录 / 运行环境 / git 分支」在每次组 prompt 时采集进来，
// 让模型知道"此刻在哪、什么环境"，是 Claude Code 类工具的真实做法。
// 纯 I/O 与组合逻辑隔离到本文件，便于单测时注入固定 now、并对 git 失败做容错。

import { execSync } from 'node:child_process';
import { platform, arch } from 'node:os';

export interface DynamicContext {
  cwd: string;
  /** 本地化时间字符串（zh-CN，24 小时制） */
  now: string;
  /** 操作系统 + 架构，如 "linux x64" */
  os: string;
  /** 当前 git 分支；非 git 仓库或 git 不可用时为 undefined（不抛） */
  gitBranch?: string;
}

/** 采集动态上下文。now 可注入以便单测确定性；git 调用失败静默降级。 */
export function gatherContext(cwd: string, now: Date = new Date()): DynamicContext {
  let gitBranch: string | undefined;
  try {
    const raw = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    })
      .toString()
      .trim();
    if (raw) gitBranch = raw;
  } catch {
    // 非 git 仓库 / git 不可用 / 超时：忽略，不阻断主流程
    gitBranch = undefined;
  }

  return {
    cwd,
    now: now.toLocaleString('zh-CN', { hour12: false }),
    os: `${platform()} ${arch()}`,
    gitBranch,
  };
}
