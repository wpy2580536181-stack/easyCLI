import { describe, it, expect } from 'vitest';
import { runPlanAndExecute } from '../../src/core/agent/plan-execute';
import { TodoStore } from '../../src/core/tools/planning';
import type { ChatModel, ChatMessage, CompleteResult } from '../../src/core/chatmodel/types';
import type { ToolRegistry } from '../../src/core/tools/registry';

function fakeRegistry(): ToolRegistry {
  const map = new Map<string, unknown>();
  return { get: (n: string) => map.get(n), list: () => [], has: () => false } as unknown as ToolRegistry;
}

interface Call {
  system: string;
  user: string;
  messages: ChatMessage[];
}

/** 构造一个假模型：按系统提示区分 Plan/Step/Synthesis 三类调用，Step 不返回工具调用（runAgent 一次性结束） */
function makeModel(planContent: string): { model: ChatModel; calls: Call[] } {
  const calls: Call[] = [];
  const model = {
    id: 'fake',
    async complete(opts: { messages: ChatMessage[] }): Promise<CompleteResult> {
      const messages = opts.messages;
      const sys = typeof messages[0]?.content === 'string' ? messages[0].content : '';
      const user = messages
        .filter((m) => m.role === 'user')
        .map((m) => (typeof m.content === 'string' ? m.content : ''))
        .join('\n');
      calls.push({ system: sys, user, messages });
      if (sys.includes('任务规划专家')) return { content: planContent, toolCalls: [] };
      if (sys.includes('总结专家')) return { content: '综合结论文本', toolCalls: [] };
      return { content: `完成[${user.slice(0, 16)}]`, toolCalls: [] };
    },
  } as unknown as ChatModel;
  return { model, calls };
}

describe('runPlanAndExecute（差异6：单 Agent 顺序规划 + 逐步执行）', () => {
  const PLAN = JSON.stringify({
    goal: 'g',
    steps: [
      { id: 's1', description: '第一步' },
      { id: 's2', description: '第二步', verification: '无错误' },
    ],
  });

  it('按序执行、前序结果喂回下一步、Synthesis 综合结论', async () => {
    const { model, calls } = makeModel(PLAN);
    const store = new TodoStore();
    const res = await runPlanAndExecute({
      task: 'T',
      model,
      tools: fakeRegistry(),
      cwd: '/tmp',
      todoStore: store,
      synthesize: true,
    });

    expect(res.plan.steps.length).toBe(2);
    expect(res.steps[0]!.ok).toBe(true);
    expect(res.steps[0]!.output.startsWith('完成')).toBe(true);
    expect(res.steps[1]!.ok).toBe(true);
    expect(res.synthesis).toBe('综合结论文本');

    // 两类 step 调用：第一步无前置注入，第二步有「之前步骤的产出」喂回
    const stepCalls = calls.filter((c) => c.system.includes('执行工程师'));
    expect(stepCalls.length).toBe(2);
    expect(stepCalls[0]!.system).not.toContain('之前步骤的产出');
    expect(stepCalls[1]!.system).toContain('之前步骤的产出');

    // 进度同步到 TodoStore（全部 completed）
    const items = store.list();
    expect(items.length).toBe(2);
    expect(items.every((t) => t.status === 'completed')).toBe(true);
  });

  it('synthesize=false：跳过 Synthesis 阶段，synthesis 为空', async () => {
    const { model, calls } = makeModel(PLAN);
    const res = await runPlanAndExecute({
      task: 'T',
      model,
      tools: fakeRegistry(),
      cwd: '/tmp',
      synthesize: false,
    });
    expect(res.synthesis).toBe('');
    // 调用数 = 1(plan) + n(steps) + 0(synthesis) = 3
    expect(calls.length).toBe(3);
  });

  it('计划 JSON 畸形：退化成单步执行', async () => {
    const { model } = makeModel('这不是合法 JSON，只是普通文本');
    const res = await runPlanAndExecute({
      task: 'T',
      model,
      tools: fakeRegistry(),
      cwd: '/tmp',
    });
    expect(res.plan.steps.length).toBe(1);
    expect(res.steps.length).toBe(1);
    expect(res.steps[0]!.ok).toBe(true);
  });
});
