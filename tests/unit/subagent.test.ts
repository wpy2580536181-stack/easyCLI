import { describe, it, expect } from 'vitest';
import { createToolRegistry, ToolRegistry } from '../../src/core/tools/registry';
import { PermissionManager } from '../../src/core/security/permission';
import { EventBus } from '../../src/core/events/bus';
import { buildAgentSystemPrompt } from '../../src/core/prompts';
import { runAgent } from '../../src/core/agent/loop';
import type { ChatMessage, ChatModel, CompleteResult, ToolDef, ToolContext } from '../../src/core/chatmodel/types';
import { getSubagentTools, spawnSubagent, buildSubagentTools } from '../../src/core/multiagent/subagent';

/** 父/子角色感知 mock 模型：
 *  - 子 Agent 系统提示含「执行工程师」→ 首轮调 read_file，次轮回结论文本；
 *  - 父 Agent → 首轮调 task 工具，拿到结论后回总结。 */
class ParentChildModel implements ChatModel {
  readonly id = 'mock:pc';
  /** 子 Agent 首次收到的 messages（用于断言上下文隔离） */
  subAgentFirstMessages: ChatMessage[] | null = null;
  async complete(opts: { messages: ChatMessage[] }): Promise<CompleteResult> {
    const sys = opts.messages.find((m) => m.role === 'system');
    const sysText = typeof sys?.content === 'string' ? sys.content : '';
    if (sysText.includes('执行工程师')) {
      if (!this.subAgentFirstMessages) this.subAgentFirstMessages = opts.messages.slice();
      const hasTool = opts.messages.some((m) => m.role === 'tool');
      if (!hasTool) return { content: '', toolCalls: [{ id: 'r1', name: 'read_file', arguments: { path: 'x' } }] };
      return { content: '子 agent 结论：项目使用 vitest 做测试', toolCalls: [] };
    }
    const hasTaskResult = opts.messages.some((m) => m.role === 'tool');
    if (hasTaskResult) return { content: '父 agent：子 agent 说用 vitest', toolCalls: [] };
    return { content: '', toolCalls: [{ id: 'p1', name: 'task', arguments: { description: '查找测试框架' } }] };
  }
}

/** 一个总是成功的 mock 读工具（避免真实文件系统） */
function makeReadTool(): ToolDef {
  return {
    name: 'read_file',
    description: 'read a file',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
    isReadOnly: true,
    execute: async (_args: Record<string, unknown>, _ctx: ToolContext) => ({ ok: true, output: 'file content' }),
  };
}

const cwd = process.cwd();

describe('Phase 23 · Subagent 工具集裁剪（防递归）', () => {
  it('buildSubagentTools 剔除 task 但保留其余工具', () => {
    const reg = createToolRegistry();
    reg.register(makeReadTool());
    reg.register({ name: 'bash', description: '', inputSchema: { type: 'object', properties: {} }, execute: async () => ({ ok: true, output: '' }) });
    // 模拟主注册表已含 task
    reg.register({ name: 'task', description: '', inputSchema: { type: 'object', properties: {} }, execute: async () => ({ ok: true, output: '' }) });

    const sub = buildSubagentTools(reg);
    expect(sub.has('task')).toBe(false); // 关键：子 Agent 无 task，防递归
    expect(sub.has('read_file')).toBe(true);
    expect(sub.has('bash')).toBe(true);
  });
});

describe('Phase 23 · task 工具定义', () => {
  it('导出名为 task、isReadOnly=true 的工具', () => {
    const tools = getSubagentTools({ model: {} as ChatModel, permission: new PermissionManager(), cwd, tools: createToolRegistry() });
    expect(tools.length).toBe(1);
    expect(tools[0]!.name).toBe('task');
    expect(tools[0]!.isReadOnly).toBe(true);
  });
});

describe('Phase 23 · spawnSubagent 端到端', () => {
  it('只回传子 Agent 结论文本', async () => {
    const reg = createToolRegistry();
    reg.register(makeReadTool());
    const model = new ParentChildModel();
    const conclusion = await spawnSubagent({ model, permission: new PermissionManager({ registry: reg, defaultForAsk: 'allow' }), cwd, tools: reg, description: '查找测试框架' });
    expect(conclusion).toContain('vitest');
  });

  it('父 Agent 在循环内自主调用 task，子 Agent 上下文隔离（全新 messages[]）', async () => {
    const reg = createToolRegistry();
    reg.register(makeReadTool());
    const model = new ParentChildModel();
    reg.registerAll(getSubagentTools({ model, permission: new PermissionManager({ registry: reg, defaultForAsk: 'allow' }), cwd, tools: reg }));

    const sys = buildAgentSystemPrompt({ cwd, toolNames: reg.list().map((t) => t.name), now: new Date() });
    const history: ChatMessage[] = [
      { role: 'system', content: sys },
      { role: 'user', content: '请查找本项目用的测试框架' },
    ];
    await runAgent(history, {
      model,
      tools: reg,
      permission: new PermissionManager({ registry: reg, defaultForAsk: 'allow' }),
      cwd,
      maxIterations: 10,
    });

    const finalText = history.filter((m) => m.role === 'assistant').map((m) => (typeof m.content === 'string' ? m.content : '')).join('');
    // 子 Agent 结论应回传到父 Agent 的最终回复中
    expect(finalText).toContain('vitest');

    // 上下文隔离：子 Agent 首条消息应是 [system, user] 全新上下文，不含父历史 / task 调用
    const sub = model.subAgentFirstMessages!;
    expect(sub).not.toBeNull();
    expect(sub.length).toBe(2);
    expect(sub.some((m) => m.role === 'tool')).toBe(false);
    expect(JSON.stringify(sub)).not.toContain('"task"');
  });

  it('空 description 时不派发、返回提示', async () => {
    const reg = createToolRegistry();
    const out = await spawnSubagent({ model: {} as ChatModel, permission: new PermissionManager(), cwd, tools: reg, description: '   ' });
    expect(out).toContain('未派发');
  });
});
