import { describe, it, expect } from 'vitest';
import { MemoryStore } from '../../src/core/memory/store';
import { getMemoryTools } from '../../src/core/memory/tools';

describe('MemoryStore (SQLite)', () => {
  it('remember / recall / search / clear', () => {
    const s = new MemoryStore(':memory:');
    const id1 = s.remember('用户偏好用中文回答');
    const id2 = s.remember('项目用 pnpm 管理依赖');
    expect(id2).toBe(id1 + 1);

    const all = s.recall(10);
    expect(all).toHaveLength(2);
    expect(all[0]!.fact).toBe('项目用 pnpm 管理依赖'); // 倒序，最新在前
    expect(all[0]!.source).toBe('agent');
    expect(all[0]!.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}/);

    const hit = s.search('pnpm');
    expect(hit).toHaveLength(1);
    expect(hit[0]!.fact).toBe('项目用 pnpm 管理依赖');

    s.clear();
    expect(s.recall(10)).toHaveLength(0);
  });
});

describe('记忆工具 remember / recall', () => {
  it('工具执行体正确读写记忆库', async () => {
    const s = new MemoryStore(':memory:');
    const mt = getMemoryTools(s);
    const remember = mt[0]!;
    const recall = mt[1]!;

    const r1 = await remember.execute!({ fact: '测试事实一' }, { cwd: '.' });
    expect(r1.ok).toBe(true);
    expect(r1.output).toContain('已记住');

    const r2 = await recall.execute!({}, { cwd: '.' });
    expect(r2.ok).toBe(true);
    expect(r2.output).toContain('测试事实一');

    const r3 = await recall.execute!({ query: '不存在xyz' }, { cwd: '.' });
    expect(r3.output).toContain('（记忆库为空或无可匹配项）');

    const r4 = await remember.execute!({}, { cwd: '.' });
    expect(r4.ok).toBe(false); // 缺 fact
  });

  it('recall 是只读工具（权限默认放行）', () => {
    const mt = getMemoryTools(new MemoryStore(':memory:'));
    const remember = mt[0]!;
    const recall = mt[1]!;
    expect(remember.isReadOnly).toBe(false);
    expect(recall.isReadOnly).toBe(true);
  });
});
