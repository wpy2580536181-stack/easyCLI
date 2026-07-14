import { describe, it, expect } from 'vitest';
import { resolveWorkerRole, buildResearcherSystemPrompt, buildArchitectSystemPrompt } from '../../src/core/multiagent/prompts';
import type { Subtask } from '../../src/core/multiagent/types';

describe('Multi-Agent 角色解析（差异5）', () => {
  it('默认（undefined）→ Worker，planMode=false', () => {
    const r = resolveWorkerRole(undefined);
    expect(r.label).toBe('Worker');
    expect(r.planMode).toBe(false);
  });

  it('researcher → 只读 gate + Researcher 提示', () => {
    const r = resolveWorkerRole('researcher');
    expect(r.label).toBe('Researcher');
    expect(r.planMode).toBe(true);
    const s: Subtask = { id: 's1', title: 't', description: 'd' };
    expect(r.build('task', s, '/w')).toContain('只读');
  });

  it('architect → 只读 gate + Architect 提示', () => {
    const r = resolveWorkerRole('architect');
    expect(r.label).toBe('Architect');
    expect(r.planMode).toBe(true);
    const s: Subtask = { id: 's1', title: 't', description: 'd' };
    expect(r.build('task', s, '/w')).toContain('架构师');
  });

  it('显式 worker → 可写、用原 Worker 提示', () => {
    const r = resolveWorkerRole('worker');
    expect(r.planMode).toBe(false);
    const s: Subtask = { id: 's1', title: 't', description: 'd' };
    expect(r.build('task', s, '/w')).toContain('执行工程师');
  });

  it('角色提示包含任务/子任务/cwd 上下文', () => {
    const s: Subtask = { id: 's1', title: '调研登录', description: '找认证模块' };
    const r = buildResearcherSystemPrompt('总任务X', s, '/wt/s1');
    expect(r).toContain('总任务X');
    expect(r).toContain('调研登录');
    expect(r).toContain('/wt/s1');
    const a = buildArchitectSystemPrompt('总任务X', s, '/wt/s1');
    expect(a).toContain('总任务X');
    expect(a).toContain('/wt/s1');
  });
});
