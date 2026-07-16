// 重构（模块 A/C）：结构化产物与评审结论的程序化提取工具。
//
// 解决现状两大短板：
// 1. Worker 间依赖仅靠「最后一条 assistant 文本」传递 → 大产出会摘要损失；
//    这里用 `computeChangedFiles` 程序化 diff（git worktree 走 git diff；
//    copy 兜底走目录比对），100% 可靠、不依赖模型格式。
// 2. Reviewer 只给纯文本 → 无法触发纠偏回路；
//    `parseReviewVerdict` 解析结构化 JSON（zod 兜底，失败返回 null → 退化纯文本）。
//
// 另含 `mergeWorktree`（模块 C 的 auto-merge 落到主分支）。

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { z } from 'zod';
import type { Worktree } from './worktree';
import type { ReviewVerdict, ReviewFix, Subtask, WorkerResult } from './types';

/**
 * 程序化计算某 Worker 相对基线的改动文件清单。
 * - git worktree：git diff --name-only HEAD（最可靠，含新增/修改/删除）。
 * - copy 兜底：仅遍历 wt 目录，返回「新增或内容变更」的相对路径
 *   （不检测删除；删改在 copy 兜底场景下罕见，且避免遍历整个大基线目录）。
 * @param wt 该 Worker 的隔离工作目录句柄
 * @param baseCwd 基线目录（项目根）
 */
export async function computeChangedFiles(wt: Worktree, baseCwd: string): Promise<string[]> {
  if (wt.kind === 'git') {
    try {
      const out = execFileSync('git', ['diff', '--name-only', 'HEAD'], {
        cwd: wt.path,
        encoding: 'utf8',
      });
      return out
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
    } catch {
      // git 失败（如空仓库）→ 落到目录比对
    }
  }
  return diffDirs(baseCwd, wt.path);
}

/** 遍历 wt 目录，返回相对基线路径中「新增或内容变更」的文件（跳过 node_modules/.git） */
function diffDirs(base: string, wt: string): string[] {
  const changed: string[] = [];
  walk(wt, (rel) => {
    if (rel.split(sep).includes('node_modules') || rel.split(sep).includes('.git')) return;
    const baseFile = join(base, rel);
    const wtFile = join(wt, rel);
    if (!existsSync(baseFile)) {
      changed.push(rel); // 新增
      return;
    }
    if (!contentEqual(baseFile, wtFile)) changed.push(rel); // 内容变更
  });
  return changed;
}

function walk(dir: string, visit: (rel: string, abs: string) => void, prefix = ''): void {
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const abs = join(dir, e.name);
    const rel = prefix ? join(prefix, e.name) : e.name;
    if (e.isDirectory()) walk(abs, visit, rel);
    else visit(rel, abs);
  }
}

function contentEqual(a: string, b: string): boolean {
  try {
    const sa = statSync(a);
    const sb = statSync(b);
    if (sa.size !== sb.size) return false;
    return readFileSync(a).equals(readFileSync(b));
  } catch {
    return false;
  }
}

const ReviewVerdictSchema = z.object({
  verdict: z.enum(['pass', 'needs-fix', 'fail']).optional(),
  fixes: z
    .array(
      z.object({
        targetId: z.union([z.string(), z.number()]),
        instruction: z.string(),
      }),
    )
    .optional(),
  summary: z.string().optional(),
});

/**
 * 从 Reviewer 文本中解析结构化评审结论。
 * 兼容 ```json 围栏 或裸 JSON；解析/校验失败返回 null（调用方据此退化为纯文本 pass）。
 */
export function parseReviewVerdict(text: string | undefined): ReviewVerdict | null {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1]! : text.match(/\{[\s\S]*\}/)?.[0];
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    const result = ReviewVerdictSchema.safeParse(parsed);
    if (!result.success) return null;
    const d = result.data;
    return {
      verdict: d.verdict ?? 'pass',
      fixes: (d.fixes ?? []).map((f) => ({ targetId: String(f.targetId), instruction: f.instruction })),
      summary: d.summary ?? text,
    };
  } catch {
    return null;
  }
}

/**
 * 把 Reviewer 的修正指令（fixes）转为「补充子任务」（重规划用）。
 * 每个 fix 生成一个 id 形如 `re{n}-{targetId}`、dependsOn 指回原目标的子任务。
 * 旧 WorkerResult 保留在 allWorkers 中（ok=false 计入最终 allOk）。
 */
export function buildSupplementSubtasks(
  fixes: ReviewFix[],
  workers: WorkerResult[],
  round: number,
): Subtask[] {
  const byId = new Map(workers.map((w) => [w.subtask.id, w]));
  return fixes.map((f) => {
    const target = byId.get(f.targetId);
    return {
      id: `re${round}-${f.targetId}`,
      title: `修正 [${f.targetId}] ${target?.subtask.title ?? ''}`.trim(),
      description: f.instruction,
      role: target?.subtask.role ?? 'worker',
      dependsOn: [f.targetId],
    } satisfies Subtask;
  });
}

/**
 * 把一个隔离 worktree 的改动合并回基线分支（auto-merge 策略）。
 * 仅支持 git 类型；copy 兜底无合并语义，调用方应改选 keep/auto-cleanup-success。
 * 冲突时抛出（调用方 catch 后转 keep + 告警，绝不丢改动）。
 * @param wt 要合并的 worktree 句柄（git 类型）
 * @param baseCwd 基线目录（当前所在分支即合并目标）
 */
export async function mergeWorktree(wt: Worktree, baseCwd: string): Promise<void> {
  if (wt.kind !== 'git') {
    throw new Error('copy 模式 worktree 不支持自动合并（请改用 keep 或 auto-cleanup-success）');
  }
  const wtHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: wt.path, encoding: 'utf8' }).trim();
  execFileSync('git', ['merge', '--no-ff', wtHead, '-m', `easyCLI: merge worktree ${wt.id}`], {
    cwd: baseCwd,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
}
