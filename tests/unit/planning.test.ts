import { describe, it, expect } from 'vitest';
import {
  TodoStore,
  getPlanningTools,
  renderTodos,
  type TodoItem,
} from '../../src/core/tools/planning';

const ctx = { cwd: process.cwd() };

describe('TodoStore', () => {
  it('set / list / clear（整表覆盖 + 只读快照）', () => {
    const s = new TodoStore();
    expect(s.list()).toHaveLength(0);

    const a: TodoItem[] = [{ content: '步骤一', status: 'pending' }];
    s.set(a);
    expect(s.list()).toHaveLength(1);

    // list() 返回快照，改动不影响内部
    const snap = s.list();
    snap.push({ content: 'x', status: 'pending' });
    expect(s.list()).toHaveLength(1);

    // 整表覆盖
    s.set([
      { content: '步骤一', status: 'completed' },
      { content: '步骤二', status: 'in_progress' },
    ]);
    expect(s.list()).toHaveLength(2);
    expect(s.list()[0]!.status).toBe('completed');

    s.clear();
    expect(s.list()).toHaveLength(0);
  });
});

describe('renderTodos', () => {
  it('空清单', () => {
    expect(renderTodos([])).toBe('（任务清单为空）');
  });

  it('渲染图标与进度', () => {
    const out = renderTodos([
      { content: '写测试', status: 'completed' },
      { content: '跑测试', status: 'in_progress' },
      { content: '修复失败', status: 'pending' },
    ]);
    expect(out).toContain('[✓] 写测试');
    expect(out).toContain('[▸] 跑测试');
    expect(out).toContain('[ ] 修复失败');
    expect(out).toContain('进度：1/3 已完成');
  });
});

describe('todo_write 工具', () => {
  const getTool = () => {
    const store = new TodoStore();
    const [tool] = getPlanningTools(store);
    return { store, tool: tool! };
  };

  it('工具元信息：只读、非破坏性', () => {
    const { tool } = getTool();
    expect(tool.name).toBe('todo_write');
    expect(tool.isReadOnly).toBe(true);
    expect(tool.isDestructive).toBe(false);
  });

  it('写入清单并回显进度', async () => {
    const { store, tool } = getTool();
    const res = await tool.execute!(
      {
        todos: [
          { content: '步骤一', status: 'in_progress' },
          { content: '步骤二', status: 'pending' },
        ],
      },
      ctx,
    );
    expect(res.ok).toBe(true);
    expect(res.output).toContain('已更新任务清单（2 项）');
    expect(res.output).toContain('[▸] 步骤一');
    expect(store.list()).toHaveLength(2);
  });

  it('规范化：丢弃空 content，非法状态回落 pending，保留 activeForm', async () => {
    const { store, tool } = getTool();
    const res = await tool.execute!(
      {
        todos: [
          { content: '  ', status: 'pending' }, // 空内容 → 丢弃
          { content: '有效', status: 'bogus', activeForm: '正在做' }, // 非法状态 → pending
        ],
      },
      ctx,
    );
    expect(res.ok).toBe(true);
    const items = store.list();
    expect(items).toHaveLength(1);
    expect(items[0]!.content).toBe('有效');
    expect(items[0]!.status).toBe('pending');
    expect(items[0]!.activeForm).toBe('正在做');
  });

  it('缺少 todos 或全部非法 → 返回错误', async () => {
    const { tool } = getTool();
    expect((await tool.execute!({}, ctx)).ok).toBe(false);
    expect((await tool.execute!({ todos: 'x' }, ctx)).ok).toBe(false);
    expect((await tool.execute!({ todos: [{ content: '' }] }, ctx)).ok).toBe(false);
  });

  it('多个 in_progress 触发软告警（仍写入）', async () => {
    const { store, tool } = getTool();
    const res = await tool.execute!(
      {
        todos: [
          { content: 'a', status: 'in_progress' },
          { content: 'b', status: 'in_progress' },
        ],
      },
      ctx,
    );
    expect(res.ok).toBe(true);
    expect(res.output).toContain('⚠');
    expect(store.list()).toHaveLength(2);
  });
});
