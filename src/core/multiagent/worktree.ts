// Phase 17：文件隔离 worktree（决策 11）。
//
// 多个 Worker 并发改写同一份代码时，若共用同一个 cwd 会互相覆盖冲突。
// 因此每个 Worker 跑在「独立的隔离工作目录」里：
// - 优先用 git worktree add（真正的工作树隔离，改动彼此独立、可单独 review）；
// - 若不在 git 仓库或 git 失败，则退化为「目录拷贝」（剔除 node_modules/.git 减重），
//   同样保证每个 Worker 写的是自己的副本。
// 无论哪种方式，使用完都要 cleanup 释放，避免磁盘/工作树泄漏。

import { execFileSync } from 'node:child_process';
import { mkdtempSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

/** 一个隔离的工作目录句柄 */
export interface Worktree {
  id: string;
  /** 隔离目录的实际路径（Worker 的 cwd 就设在这里） */
  path: string;
  /** 隔离方式：'git' = git worktree；'copy' = 目录拷贝兜底 */
  kind: 'git' | 'copy';
  /** 释放资源（git worktree remove 或 rm -rf） */
  cleanup: () => void;
}

/** 当前目录是否处于 git 工作树内 */
function isGitRepo(cwd: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * 为某个 Worker 创建一个隔离工作目录。
 * @param baseCwd 基线目录（通常是项目根）
 * @param id Worker 标识（用于命名与排障）
 */
export async function createWorktree(baseCwd: string, id: string): Promise<Worktree> {
  const tmp = mkdtempSync(join(tmpdir(), `easycli-wt-${id}-`));

  // 优先：git worktree —— 真正的文件树隔离
  if (isGitRepo(baseCwd)) {
    try {
      execFileSync('git', ['worktree', 'add', '--detach', tmp, 'HEAD'], {
        cwd: baseCwd,
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      return {
        id,
        path: tmp,
        kind: 'git',
        cleanup: () => {
          try {
            execFileSync('git', ['worktree', 'remove', '--force', tmp], {
              cwd: baseCwd,
              stdio: ['ignore', 'ignore', 'ignore'],
            });
          } catch {
            rmSync(tmp, { recursive: true, force: true });
          }
        },
      };
    } catch {
      // git 失败（如工作树不干净）→ 退化为拷贝
    }
  }

  // 兜底：目录拷贝（排除重目录，控制体积）
  cpSync(baseCwd, tmp, {
    recursive: true,
    filter: (src) =>
      !src.split(sep).includes('node_modules') && !src.split(sep).includes('.git'),
  });
  return {
    id,
    path: tmp,
    kind: 'copy',
    cleanup: () => rmSync(tmp, { recursive: true, force: true }),
  };
}
