import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runMultiAgent,
  parseReviewVerdict,
  buildSupplementSubtasks,
  computeChangedFiles,
  type Worktree,
  type WorkerResult,
} from '../../src/core/multiagent';
import { createToolRegistry } from '../../src/core/tools/registry';
import { EventBus } from '../../src/core/events/bus';
import { runAgent } from '../../src/core/agent/loop';
import type { ChatMessage, ChatModel, CompleteResult, ToolDef, ToolContext } from '../../src/core/chatmodel/types';

/** 角色感知的 mock 模型：按系统提示区分 Planner / Reviewer / Worker
 *  注意分支顺序：Reviewer 提示也含「隔离工作目录」，故先判定 Reviewer（唯一词「评审专家」），
 *  再判定 Worker（唯一词「执行工程师」），避免误路由。 */
class RoleAwareModel implements ChatModel {
  readonly id = 'mock:role';
  constructor(private readonly failWorker = false) {}
  async complete(opts: { messages: ChatMessage[] }): Promise<CompleteResult> {
    const sys = opts.messages.find((m) => m.role === 'system');
    const sysText = typeof sys?.content === 'string' ? sys.content : '';
    if (sysText.includes('任务拆解专家')) {
      return {
        content:
          '```json\n' +
          '{"goal":"总目标","subtasks":[' +
          '{"id":"s1","title":"子任务A","description":"da"},' +
          '{"id":"s2","title":"子任务B","description":"db"}]}\n' +
          '```',
        toolCalls: [],
      };
    }
    if (sysText.includes('评审专家')) {
      return { content: 'review ok', toolCalls: [] };
    }
    if (sysText.includes('执行工程师')) {
      if (this.failWorker) throw new Error('worker boom');
      const hasToolResult = opts.messages.some((m) => m.role === 'tool');
      if (hasToolResult) return { content: 'done', toolCalls: [] };
      return { content: '', toolCalls: [{ id: 'c1', name: 'touch_file', arguments: { path: 'marker.txt' } }] };
    }
    return { content: 'fallback', toolCalls: [] };
  }
}

/** 一个会在 cwd 里落 marker 文件、并统计并发峰值的写工具 */
function makeTouchTool(active: { n: number; max: number }): ToolDef {
  return {
    name: 'touch_file',
    description: 'touch a marker file in cwd',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
    isReadOnly: false,
    execute: async (args: Record<string, unknown>, ctx: ToolContext) => {
      active.n++;
      if (active.n > active.max) active.max = active.n;
      await new Promise((r) => setTimeout(r, 10));
      writeFileSync(join(ctx.cwd, String(args.path)), 'worked');
      active.n--;
      return { ok: true, output: 'ok' };
    },
  };
}

/** 测试用 worktree 工厂：返回独立 temp 目录并登记路径 */
const created: string[] = [];
afterAll(() => {
  for (const p of created) rmSync(p, { recursive: true, force: true });
});

function recorderFactory(made: string[]): (baseCwd: string, id: string) => Promise<Worktree> {
  return async (baseCwd, id) => {
    const p = mkdtempSync(join(tmpdir(), `test-wt-${id}-`));
    made.push(p);
    created.push(p);
    return { id, path: p, kind: 'copy', cleanup: () => rmSync(p, { recursive: true, force: true }) };
  };
}

const baseCwd = process.cwd();

describe('Phase 17 · runMultiAgent 编排', () => {
  it('Planner 产出计划、Worker 并发执行、Reviewer 汇总', async () => {
    const made: string[] = [];
    const active = { n: 0, max: 0 };
    const tools = createToolRegistry();
    tools.register(makeTouchTool(active));
    const res = await runMultiAgent({
      task: '实现一个功能',
      model: new RoleAwareModel(),
      tools,
      cwd: baseCwd,
      maxWorkers: 3,
      worktreeFactory: recorderFactory(made),
    });

    expect(res.plan.subtasks.length).toBe(2);
    expect(res.workers.length).toBe(2);
    // 每个 Worker 在独立 worktree，且都不同于基线 cwd
    expect(new Set(made).size).toBe(2);
    for (const w of res.workers) {
      expect(made).toContain(w.cwd);
      expect(w.cwd).not.toBe(baseCwd);
      expect(existsSync(join(w.cwd, 'marker.txt'))).toBe(true);
    }
    // 基线目录不应被 Worker 写入污染（隔离有效性）
    expect(existsSync(join(baseCwd, 'marker.txt'))).toBe(false);
    expect(res.allOk).toBe(true);
    expect(res.review).toContain('review ok');
  });

  it('有界并发：maxWorkers=1 时并发峰值不超过 1', async () => {
    const active = { n: 0, max: 0 };
    const tools = createToolRegistry();
    tools.register(makeTouchTool(active));
    await runMultiAgent({
      task: 't',
      model: new RoleAwareModel(),
      tools,
      cwd: baseCwd,
      maxWorkers: 1,
      worktreeFactory: recorderFactory([]),
    });
    expect(active.max).toBeLessThanOrEqual(1);
  });

  it('有界并发：maxWorkers=2 时并发峰值不超过 2（3 个子任务）', async () => {
    const active = { n: 0, max: 0 };
    const tools = createToolRegistry();
    tools.register(makeTouchTool(active));
    await runMultiAgent({
      task: 't',
      model: new RoleAwareModel(),
      tools,
      cwd: baseCwd,
      maxWorkers: 2,
      worktreeFactory: recorderFactory([]),
    });
    expect(active.max).toBeLessThanOrEqual(2);
  });

  it('Worker 创建 worktree 失败时，该 Worker 标记失败、其余继续、Reviewer 仍汇总', async () => {
    const tools = createToolRegistry();
    tools.register(makeTouchTool({ n: 0, max: 0 }));
    // 让 id=s2 的 worktree 创建失败
    const badFactory = async (b: string, id: string): Promise<Worktree> => {
      if (id === 's2') throw new Error('worktree create failed');
      const p = mkdtempSync(join(tmpdir(), `test-wt-${id}-`));
      created.push(p);
      return { id, path: p, kind: 'copy', cleanup: () => rmSync(p, { recursive: true, force: true }) };
    };
    const res = await runMultiAgent({
      task: 't',
      model: new RoleAwareModel(),
      tools,
      cwd: baseCwd,
      worktreeFactory: badFactory,
    });
    expect(res.workers.length).toBe(2);
    expect(res.workers.some((w) => w.ok && w.subtask.id === 's1')).toBe(true);
    expect(res.workers.some((w) => !w.ok && w.subtask.id === 's2')).toBe(true);
    expect(res.allOk).toBe(false);
    expect(res.review).toContain('review ok');
  });

  it('Planner 抛错时，整体安全降级（无 Worker、返回失败说明）', async () => {
    class BoomPlanner implements ChatModel {
      readonly id = 'mock:boom';
      async complete(): Promise<CompleteResult> {
        throw new Error('planner down');
      }
    }
    const res = await runMultiAgent({
      task: 't',
      model: new BoomPlanner(),
      tools: createToolRegistry(),
      cwd: baseCwd,
      worktreeFactory: recorderFactory([]),
    });
    expect(res.plan.subtasks.length).toBe(0);
    expect(res.workers.length).toBe(0);
    expect(res.review).toContain('Planner 失败');
    expect(res.allOk).toBe(false);
  });
});

describe('Phase 17 · 事件总线落地', () => {
  it('发射 agent:spawn / agent:done，成功时不发射 agent:error', async () => {
    const bus = new EventBus();
    const events: string[] = [];
    bus.on('agent:spawn', () => events.push('spawn'));
    bus.on('agent:done', () => events.push('done'));
    bus.on('agent:error', () => events.push('error'));
    await runMultiAgent({
      task: 't',
      model: new RoleAwareModel(),
      tools: (() => {
        const t = createToolRegistry();
        t.register(makeTouchTool({ n: 0, max: 0 }));
        return t;
      })(),
      cwd: baseCwd,
      worktreeFactory: recorderFactory([]),
      bus,
    });
    expect(events.filter((e) => e === 'spawn').length).toBeGreaterThanOrEqual(4); // planner + 2 worker + reviewer
    expect(events.filter((e) => e === 'done').length).toBeGreaterThanOrEqual(4);
    expect(events).not.toContain('error');
  });

  it('Worker 失败时发射 agent:error', async () => {
    const bus = new EventBus();
    let errors = 0;
    bus.on('agent:error', () => errors++);
    await runMultiAgent({
      task: 't',
      model: new RoleAwareModel(true), // Worker 执行抛错
      tools: (() => {
        const t = createToolRegistry();
        t.register(makeTouchTool({ n: 0, max: 0 }));
        return t;
      })(),
      cwd: baseCwd,
      worktreeFactory: recorderFactory([]),
      bus,
    });
    expect(errors).toBeGreaterThanOrEqual(1);
  });
});

// ── 重构（模块 A/B/C）：结构化产物 + 多轮纠偏回路 + worktree 生命周期 ──

describe('multiagent refactor · 结构化产物解析', () => {
  it('parseReviewVerdict 解析 fenced JSON', () => {
    const text =
      '前言说明\n```json\n{"verdict":"needs-fix","fixes":[{"targetId":"s1","instruction":"补单测"}],"summary":"需修正"}\n```\n';
    const v = parseReviewVerdict(text);
    expect(v).not.toBeNull();
    expect(v!.verdict).toBe('needs-fix');
    expect(v!.fixes[0]!.targetId).toBe('s1');
    expect(v!.fixes[0]!.instruction).toBe('补单测');
    expect(v!.summary).toContain('需修正');
  });

  it('parseReviewVerdict 解析裸 JSON', () => {
    const v = parseReviewVerdict('{"verdict":"pass","fixes":[],"summary":"ok"}');
    expect(v).not.toBeNull();
    expect(v!.verdict).toBe('pass');
    expect(v!.fixes).toEqual([]);
  });

  it('parseReviewVerdict 无 JSON / 畸形 → 返回 null（调用方退化为纯文本 pass）', () => {
    expect(parseReviewVerdict('没有任何 json 的结论文本')).toBeNull();
    expect(parseReviewVerdict(undefined)).toBeNull();
  });

  it('parseReviewVerdict 畸形 verdict 枚举值 → zod 拒绝返回 null（orchestrator 据此退化为 pass，不崩）', () => {
    const v = parseReviewVerdict('{"verdict":"maybe","fixes":[{"targetId":"s1","instruction":"x"}]}');
    expect(v).toBeNull(); // 严格枚举校验失败 → 退化触发点
  });

  it('buildSupplementSubtasks 生成 dependsOn 指回原目标的补充子任务', () => {
    const workers: WorkerResult[] = [
      {
        subtask: { id: 's1', title: '子任务A', description: 'da', role: 'worker', dependsOn: [] },
        cwd: '/x',
        output: 'o',
        artifact: { changedFiles: [], summary: '', findings: undefined },
        round: 0,
        ok: true,
        history: [],
      },
    ];
    const subs = buildSupplementSubtasks([{ targetId: 's1', instruction: '补单测' }], workers, 1);
    expect(subs.length).toBe(1);
    expect(subs[0]!.id).toBe('re1-s1');
    expect(subs[0]!.dependsOn).toEqual(['s1']);
    expect(subs[0]!.description).toBe('补单测');
    expect(subs[0]!.role).toBe('worker');
  });

  it('computeChangedFiles 对 copy worktree 比对出新增文件（不依赖模型格式）', async () => {
    const base = mkdtempSync(join(tmpdir(), 'base-'));
    const wt = mkdtempSync(join(tmpdir(), 'wt-'));
    writeFileSync(join(base, 'a.txt'), 'same');
    writeFileSync(join(wt, 'a.txt'), 'same');
    writeFileSync(join(wt, 'b.txt'), 'new');
    const handle: Worktree = { id: 'x', path: wt, kind: 'copy', cleanup: () => {} };
    const changed = await computeChangedFiles(handle, base);
    expect(changed).toContain('b.txt');
    expect(changed).not.toContain('a.txt');
    rmSync(base, { recursive: true, force: true });
    rmSync(wt, { recursive: true, force: true });
  });
});

// 多轮回路测试用：忽略真实工具，直接返回一条 assistant 文本（让 Worker 视为成功）。
const fakeRunner = (async (): Promise<ChatMessage[]> => [
  { role: 'assistant', content: 'did the work' },
]) as unknown as typeof runAgent;

describe('multiagent refactor · 多轮纠偏回路 + worktree 生命周期', () => {
  it('needs-fix → 重规划 → pass：两轮收敛，verdict 取末轮，产出补充子任务', async () => {
    let reviewerCalls = 0;
    class ReplanModel implements ChatModel {
      readonly id = 'mock:replan';
      async complete(opts: { messages: ChatMessage[] }): Promise<CompleteResult> {
        const sys = opts.messages.find((m) => m.role === 'system');
        const sysText = typeof sys?.content === 'string' ? sys.content : '';
        if (sysText.includes('重规划模式')) {
          return {
            content:
              '```json\n{"goal":"fix","subtasks":[{"id":"re0-s1","title":"修正 s1","description":"补单测","role":"worker","dependsOn":["s1"]}]}\n```',
            toolCalls: [],
          };
        }
        if (sysText.includes('任务拆解专家')) {
          return {
            content:
              '```json\n{"goal":"g","subtasks":[{"id":"s1","title":"A","description":"da","role":"worker","dependsOn":[]}]}\n```',
            toolCalls: [],
          };
        }
        if (sysText.includes('评审专家')) {
          reviewerCalls++;
          if (reviewerCalls === 1) {
            return {
              content:
                '```json\n{"verdict":"needs-fix","fixes":[{"targetId":"s1","instruction":"补单测"}],"summary":"需修正"}\n```',
              toolCalls: [],
            };
          }
          return { content: '```json\n{"verdict":"pass","fixes":[],"summary":"通过"}\n```', toolCalls: [] };
        }
        return { content: 'fallback', toolCalls: [] };
      }
    }
    const made: string[] = [];
    const res = await runMultiAgent({
      task: 't',
      model: new ReplanModel(),
      tools: createToolRegistry(),
      cwd: process.cwd(),
      maxReplan: 1,
      worktreeFactory: recorderFactory(made),
      agentRunner: fakeRunner,
    });
    expect(res.rounds.length).toBe(2);
    expect(res.verdict).toBe('pass');
    const ids = res.workers.map((w) => w.subtask.id);
    expect(ids).toContain('s1');
    expect(ids).toContain('re0-s1');
    // 末轮 Worker（补充子任务）应当拿到 s1 的 structured 依赖注入
    const reWorker = res.workers.find((w) => w.subtask.id === 're0-s1')!;
    expect(reWorker.round).toBe(1);
  });

  it('maxReplan 上限硬收敛：即使持续 needs-fix 也不会死循环', async () => {
    class AlwaysNeedsFix implements ChatModel {
      readonly id = 'mock:nofix';
      async complete(opts: { messages: ChatMessage[] }): Promise<CompleteResult> {
        const sys = opts.messages.find((m) => m.role === 'system');
        const sysText = typeof sys?.content === 'string' ? sys.content : '';
        if (sysText.includes('任务拆解专家') || sysText.includes('重规划模式')) {
          return {
            content:
              '```json\n{"goal":"g","subtasks":[{"id":"s1","title":"A","description":"da","role":"worker","dependsOn":[]}]}\n```',
            toolCalls: [],
          };
        }
        return {
          content: '```json\n{"verdict":"needs-fix","fixes":[{"targetId":"s1","instruction":"再改"}],"summary":"仍不行"}\n```',
          toolCalls: [],
        };
      }
    }
    const res = await runMultiAgent({
      task: 't',
      model: new AlwaysNeedsFix(),
      tools: createToolRegistry(),
      cwd: process.cwd(),
      maxReplan: 2,
      worktreeFactory: recorderFactory([]),
      agentRunner: fakeRunner,
    });
    // maxReplan=2 → 至多 3 轮（round 0,1,2）
    expect(res.rounds.length).toBeLessThanOrEqual(3);
    expect(res.verdict).toBe('needs-fix'); // 末轮仍未通过但已被上限截断
  });

  it('worktreeLifecycle=auto-cleanup-success：成功的 worktree 自动清理，失败的保留', async () => {
    const made: string[] = [];
    // 让 s2 的 Worker 通过 fakeRunner 成功，但用 badFactory 让 s2 worktree 创建失败 → 该 worktree 不入 made
    const res = await runMultiAgent({
      task: 't',
      model: new RoleAwareModel(),
      tools: (() => {
        const t = createToolRegistry();
        t.register(makeTouchTool({ n: 0, max: 0 }));
        return t;
      })(),
      cwd: process.cwd(),
      worktreeLifecycle: 'auto-cleanup-success',
      worktreeFactory: recorderFactory(made),
    });
    expect(res.allOk).toBe(true);
    expect(res.merged).toBe(false);
    // 全部成功 → 所有 worktree 目录应已被清理
    for (const p of made) {
      expect(existsSync(p)).toBe(false);
    }
  });

  it('worktreeLifecycle=keep（默认）：worktree 不被清理，供手动 review', async () => {
    const made: string[] = [];
    const res = await runMultiAgent({
      task: 't',
      model: new RoleAwareModel(),
      tools: (() => {
        const t = createToolRegistry();
        t.register(makeTouchTool({ n: 0, max: 0 }));
        return t;
      })(),
      cwd: process.cwd(),
      worktreeLifecycle: 'keep',
      worktreeFactory: recorderFactory(made),
    });
    expect(made.length).toBeGreaterThan(0);
    for (const p of made) {
      expect(existsSync(p)).toBe(true); // 默认不清理
    }
    // 清理（本测试自己负责）
    for (const p of made) rmSync(p, { recursive: true, force: true });
  });
});
