import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskStore, getTaskTools, type Task } from '../../src/core/tasks';
import type { ToolContext } from '../../src/core/chatmodel/types';

let root: string;
let store: TaskStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'easycli-tasks-'));
  store = new TaskStore(root);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('Phase 24 · TaskStore 持久化与 ID', () => {
  it('createTask 写 .tasks/{id}.json 并返回顺序 id、pending、owner=null', () => {
    const t = store.createTask({ subject: 'setup schema' });
    expect(t.id).toBe('1');
    expect(t.status).toBe('pending');
    expect(t.owner).toBeNull();
    expect(existsSync(join(root, '.tasks', '1.json'))).toBe(true);
    const onDisk = JSON.parse(readFileSync(join(root, '.tasks', '1.json'), 'utf8')) as Task;
    expect(onDisk.subject).toBe('setup schema');
  });

  it('高水位标防 ID 重用：删除 id=1 后再创建得到 id=2 而非复用', () => {
    const a = store.createTask({ subject: 'a' });
    const b = store.createTask({ subject: 'b' });
    expect(a.id).toBe('1');
    expect(b.id).toBe('2');
    store.deleteTask('1');
    const c = store.createTask({ subject: 'c' });
    expect(c.id).toBe('3'); // 不重用已删 id
    expect(existsSync(join(root, '.tasks', '1.json'))).toBe(false);
  });
});

describe('Phase 24 · 依赖图与 can_start', () => {
  it('blockedBy 未完成时 claim 被拒绝、canStart=false；完成后解锁', async () => {
    const schema = store.createTask({ subject: 'setup schema' });
    const api = store.createTask({ subject: 'create api', blockedBy: [schema.id] });

    expect(store.canStart(api.id)).toBe(false);
    const rejected = await store.claimTask(api.id);
    expect(rejected.ok).toBe(false);
    expect(rejected.msg).toContain('Blocked by');

    const done = store.completeTask(schema.id);
    expect(done.ok).toBe(true);
    expect(done.unblocked).toContain('create api');
    expect(store.canStart(api.id)).toBe(true);

    const claimed = await store.claimTask(api.id);
    expect(claimed.ok).toBe(true);
    expect(store.getTask(api.id)!.status).toBe('in_progress');
    expect(store.getTask(api.id)!.owner).toBe('agent');
  });

  it('创建时自动维护反向 blocks 边', () => {
    const schema = store.createTask({ subject: 'setup schema' });
    const api = store.createTask({ subject: 'create api', blockedBy: [schema.id] });
    expect(store.getTask(schema.id)!.blocks).toContain(api.id);
  });

  it('缺失的依赖视为 blocked', async () => {
    const orphan = store.createTask({ subject: 'x', blockedBy: ['999'] });
    expect(store.canStart(orphan.id)).toBe(false);
    const r = await store.claimTask(orphan.id);
    expect(r.ok).toBe(false);
    expect(r.msg).toContain('999');
  });

  it('已认领（非 pending）的任务再次 claim 被拒绝', async () => {
    const t = store.createTask({ subject: 't' });
    expect((await store.claimTask(t.id)).ok).toBe(true);
    const again = await store.claimTask(t.id);
    expect(again.ok).toBe(false);
    expect(again.msg).toContain('in_progress');
  });
});

describe('Phase 24 · 任务列表与读取', () => {
  it('listTasks 按 id 升序返回全部', () => {
    store.createTask({ subject: 'a' });
    store.createTask({ subject: 'b' });
    const all = store.listTasks();
    expect(all.map((t) => t.subject)).toEqual(['a', 'b']);
  });

  it('getTask 读取完整字段，不存在返回 null', () => {
    const t = store.createTask({ subject: 'a', description: 'detail' });
    expect(store.getTask(t.id)!.description).toBe('detail');
    expect(store.getTask('nope')).toBeNull();
  });

  it('completeTask 解锁多条下游', () => {
    const schema = store.createTask({ subject: 'schema' });
    const api = store.createTask({ subject: 'api', blockedBy: [schema.id] });
    const docs = store.createTask({ subject: 'docs', blockedBy: [schema.id] });
    const r = store.completeTask(schema.id);
    expect(r.unblocked.sort()).toEqual(['api', 'docs']);
    void api;
    void docs;
  });
});

describe('Phase 24 · task_* 工具封装', () => {
  function call(name: string, args: Record<string, unknown>) {
    const tools = getTaskTools(store);
    const t = tools.find((x) => x.name === name)!;
    return t.execute!(args, {} as ToolContext);
  }

  it('task_create 返回含 id 的 JSON、落盘', async () => {
    const r = await call('task_create', { subject: 'setup schema' });
    expect(r.ok).toBe(true);
    expect(r.output).toContain('"id": "1"');
    expect(existsSync(join(root, '.tasks', '1.json'))).toBe(true);
  });

  it('task_list 渲染 id/状态/依赖', async () => {
    const s = store.createTask({ subject: 'schema' });
    store.createTask({ subject: 'api', blockedBy: [s.id] });
    const r = await call('task_list', {});
    expect(r.output).toContain('schema');
    expect(r.output).toContain('api');
    expect(r.output).toContain(s.id);
  });

  it('task_get 返回完整 JSON', async () => {
    const t = store.createTask({ subject: 'a', description: 'd' });
    const r = await call('task_get', { id: t.id });
    expect(r.output).toContain('"description": "d"');
  });

  it('task_claim 依赖未完成返回 Blocked', async () => {
    const s = store.createTask({ subject: 'schema' });
    const api = store.createTask({ subject: 'api', blockedBy: [s.id] });
    const r = await call('task_claim', { id: api.id });
    expect(r.ok).toBe(false);
    expect(r.output).toContain('Blocked by');
  });

  it('task_complete 解锁下游', async () => {
    const s = store.createTask({ subject: 'schema' });
    store.createTask({ subject: 'api', blockedBy: [s.id] });
    const r = await call('task_complete', { id: s.id });
    expect(r.ok).toBe(true);
    expect(r.output).toContain('Unblocked: api');
  });

  it('task_claim 缺 id 报错', async () => {
    const r = await call('task_claim', {});
    expect(r.ok).toBe(false);
  });
});
