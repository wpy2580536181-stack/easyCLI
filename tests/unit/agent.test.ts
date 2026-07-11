import { describe, it, expect, vi } from 'vitest';
import { runAgent } from '../../src/core/agent';
import { createToolRegistry } from '../../src/core/tools/registry';
import { TodoStore, getPlanningTools } from '../../src/core/tools/planning';
import type {
  ChatMessage,
  ChatModel,
  CompleteResult,
  ToolCall,
} from '../../src/core/chatmodel/types';

/** 每次收到的 messages 里是否含 todo nag 提醒 */
function hasReminder(msgs: ChatMessage[]): boolean {
  return msgs.some((m) => typeof m.content === 'string' && m.content.includes('<reminder>'));
}

/** 脚本化模型：按预定序列循环返回 CompleteResult，模拟「先要工具、后给答案」 */
class ScriptedModel implements ChatModel {
  readonly id = 'mock:test';
  calls = 0;
  constructor(private readonly queue: CompleteResult[]) {}
  async complete(): Promise<CompleteResult> {
    const r = this.queue[this.calls % this.queue.length];
    this.calls++;
    return r ?? { content: '（兜底）', toolCalls: [] };
  }
}

const sys: ChatMessage = { role: 'system', content: 'sys' };
const user: ChatMessage = { role: 'user', content: '读一下 a.txt' };

describe('runAgent ReAct 循环', () => {
  it('模型请求工具 → 执行 → 回注 → 最终回答', async () => {
    const tools = createToolRegistry();
    const call: ToolCall = { id: 'c1', name: 'read_file', arguments: { path: 'a.txt' } };
    const model = new ScriptedModel([
      { content: '我去读一下', toolCalls: [call] },
      { content: '文件内容是 hello', toolCalls: [] },
    ]);
    const history: ChatMessage[] = [sys, user];

    await runAgent(history, { model, tools, cwd: process.cwd() });

    // sys, user, assistant(tool_call), tool(result), assistant(final) = 5
    expect(history.length).toBe(5);

    const assistantCall = history[2]!;
    expect(assistantCall.role).toBe('assistant');
    const blocks = assistantCall.content as { type: string; name?: string }[];
    expect(blocks.some((b) => b.type === 'tool_call' && b.name === 'read_file')).toBe(true);

    const toolMsg = history[3]!;
    expect(toolMsg.role).toBe('tool');
    expect(toolMsg.tool_call_id).toBe('c1');

    const final = history[4]!;
    expect(final.role).toBe('assistant');
    expect(final.content).toBe('文件内容是 hello');

    expect(model.calls).toBe(2);
  });

  it('无工具调用时一轮即结束', async () => {
    const tools = createToolRegistry();
    const model = new ScriptedModel([{ content: '直接回答', toolCalls: [] }]);
    const history: ChatMessage[] = [sys, user];

    await runAgent(history, { model, tools });

    expect(history.length).toBe(3);
    expect(model.calls).toBe(1);
  });

  it('未知工具返回错误结果且不崩溃，历史仍合法', async () => {
    const tools = createToolRegistry();
    const call: ToolCall = { id: 'x', name: 'no_such', arguments: {} };
    const model = new ScriptedModel([
      { content: '', toolCalls: [call] },
      { content: '继续', toolCalls: [] },
    ]);
    const history: ChatMessage[] = [sys, user];

    await runAgent(history, { model, tools, cwd: process.cwd() });

    expect(history.length).toBe(5);
    const toolMsg = history[3]!;
    expect(toolMsg.role).toBe('tool');
    expect(String(toolMsg.content)).toContain('未实现');
  });

  it('触发 onToolCall / onToolResult 钩子', async () => {
    const tools = createToolRegistry();
    const call: ToolCall = { id: 'c', name: 'read_file', arguments: { path: 'a.txt' } };
    const model = new ScriptedModel([
      { content: '', toolCalls: [call] },
      { content: 'done', toolCalls: [] },
    ]);
    const onToolCall = vi.fn();
    const onToolResult = vi.fn();
    const history: ChatMessage[] = [sys, user];

    await runAgent(history, { model, tools, onToolCall, onToolResult });

    expect(onToolCall).toHaveBeenCalledTimes(1);
    expect(onToolResult).toHaveBeenCalledTimes(1);
  });

  it('达到最大轮次后停止，避免留下无结果的 tool_call', async () => {
    const tools = createToolRegistry();
    const call: ToolCall = { id: 'c', name: 'read_file', arguments: { path: 'a.txt' } };
    // 永远请求工具 → 测试 maxIterations 截断
    const model = new ScriptedModel([{ content: '', toolCalls: [call] }]);
    const history: ChatMessage[] = [sys, user];

    await runAgent(history, { model, tools, maxIterations: 3, cwd: process.cwd() });

    // 3 轮：每轮 push assistant(+tool_call) 与 tool(result) = 每轮 +2
    // 初始 2 → 2 + 3*2 = 8
    expect(history.length).toBe(8);
    expect(model.calls).toBe(3);
    // 最后两条必须是配对的 assistant(tool_call) + tool(result)
    const last = history[history.length - 1]!;
    const prev = history[history.length - 2]!;
    expect(prev.role).toBe('assistant');
    expect(last.role).toBe('tool');
  });
});

describe('Phase 21：todo_write nag reminder', () => {
  /** 记录每次 complete 收到的 messages 快照 */
  class CapturingModel implements ChatModel {
    readonly id = 'mock:capture';
    calls = 0;
    seen: ChatMessage[][] = [];
    constructor(private readonly queue: CompleteResult[]) {}
    async complete(o: { messages: ChatMessage[] }): Promise<CompleteResult> {
      this.seen.push([...o.messages]);
      const r = this.queue[this.calls % this.queue.length];
      this.calls++;
      return r ?? { content: '（兜底）', toolCalls: [] };
    }
  }

  it('连续 N 轮未调 todo_write → 第 N+1 轮注入一次提醒（不写入 history）', async () => {
    const tools = createToolRegistry();
    tools.registerAll(getPlanningTools(new TodoStore()));
    const read: ToolCall = { id: 'r', name: 'read_file', arguments: { path: 'a.txt' } };
    // 永远请求 read_file（从不 todo_write）
    const model = new CapturingModel([{ content: '', toolCalls: [read] }]);
    const history: ChatMessage[] = [sys, user];

    await runAgent(history, {
      model,
      tools,
      maxIterations: 5,
      todoReminderEveryRounds: 3,
      cwd: process.cwd(),
    });

    // 前 3 次调用不含提醒，第 4 次（roundsSinceTodo 累到 3）含提醒
    expect(hasReminder(model.seen[0]!)).toBe(false);
    expect(hasReminder(model.seen[1]!)).toBe(false);
    expect(hasReminder(model.seen[2]!)).toBe(false);
    expect(hasReminder(model.seen[3]!)).toBe(true);
    // 提醒是临时注入，不落持久 history
    expect(hasReminder(history)).toBe(false);
  });

  it('每轮都调 todo_write → 永不提醒', async () => {
    const tools = createToolRegistry();
    tools.registerAll(getPlanningTools(new TodoStore()));
    const todo: ToolCall = {
      id: 't',
      name: 'todo_write',
      arguments: { todos: [{ content: 'x', status: 'in_progress' }] },
    };
    const model = new CapturingModel([{ content: '', toolCalls: [todo] }]);
    const history: ChatMessage[] = [sys, user];

    await runAgent(history, {
      model,
      tools,
      maxIterations: 5,
      todoReminderEveryRounds: 3,
      cwd: process.cwd(),
    });

    expect(model.seen.every((m) => !hasReminder(m))).toBe(true);
  });

  it('未注册 todo_write 时 nag 不生效', async () => {
    const tools = createToolRegistry(); // 无 planning 工具
    const read: ToolCall = { id: 'r', name: 'read_file', arguments: { path: 'a.txt' } };
    const model = new CapturingModel([{ content: '', toolCalls: [read] }]);
    const history: ChatMessage[] = [sys, user];

    await runAgent(history, {
      model,
      tools,
      maxIterations: 5,
      todoReminderEveryRounds: 3,
      cwd: process.cwd(),
    });

    expect(model.seen.every((m) => !hasReminder(m))).toBe(true);
  });
});
