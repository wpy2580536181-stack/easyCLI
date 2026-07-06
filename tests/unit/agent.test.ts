import { describe, it, expect, vi } from 'vitest';
import { runAgent } from '../../src/core/agent';
import { createToolRegistry } from '../../src/core/tools/registry';
import type {
  ChatMessage,
  ChatModel,
  CompleteResult,
  ToolCall,
} from '../../src/core/chatmodel/types';

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
