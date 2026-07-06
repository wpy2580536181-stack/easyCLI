import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgent } from '../../src/core/agent';
import { createToolRegistry } from '../../src/core/tools/registry';
import { EventBus, type AgentEvent } from '../../src/core/events/bus';
import { PermissionManager } from '../../src/core/security/permission';
import type { CompressOptions } from '../../src/core/memory/compressor';
import type { ChatMessage, ChatModel, CompleteResult, ToolCall } from '../../src/core/chatmodel/types';

class ScriptedModel implements ChatModel {
  readonly id = 'mock:test';
  calls = 0;
  constructor(private readonly queue: CompleteResult[]) {}
  async complete(): Promise<CompleteResult> {
    const r = this.queue[this.calls % this.queue.length]!;
    this.calls++;
    return r;
  }
}

describe('垂直集成：ReAct 循环 + 权限 + 总线 + 工具', () => {
  it('无 HITL resolver 时，写操作被默认拒绝且不落盘，总线收到事件', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'easycli-int-'));
    const tools = createToolRegistry();
    const bus = new EventBus();
    const events: AgentEvent[] = [];
    bus.on('tool:call', (e) => events.push(e));
    bus.on('tool:result', (e) => events.push(e));

    // 不注入 resolver → ask 默认 deny（安全默认）
    const permission = new PermissionManager({ settingsPath: join(dir, 'p.json'), registry: tools });

    const call: ToolCall = { id: 'w1', name: 'write_file', arguments: { path: 'out.txt', content: 'hacked' } };
    const model = new ScriptedModel([
      { content: '我来写文件', toolCalls: [call] },
      { content: '完成', toolCalls: [] },
    ]);
    const history: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '写个文件' },
    ];

    await runAgent(history, { model, tools, permission, bus, cwd: dir });

    // 工具结果应为「权限拒绝」，且磁盘上不应生成文件
    const toolMsg = history[3]!;
    expect(String(toolMsg.content)).toContain('权限拒绝');
    expect(existsSync(join(dir, 'out.txt'))).toBe(false);

    // 总线应同时收到 tool:call 与 tool:result
    expect(events.filter((e) => e.type === 'tool:call')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'tool:result')).toHaveLength(1);

    await rm(dir, { recursive: true, force: true });
  });

  it('只读工具在无 resolver 时被默认放行并执行', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'easycli-int-'));
    await writeFile(join(dir, 'a.txt'), 'hi', 'utf8');
    const tools = createToolRegistry();
    const permission = new PermissionManager({ settingsPath: join(dir, 'p2.json'), registry: tools });

    const call: ToolCall = { id: 'r1', name: 'read_file', arguments: { path: 'a.txt' } };
    const model = new ScriptedModel([
      { content: '读一下', toolCalls: [call] },
      { content: '好', toolCalls: [] },
    ]);
    const history: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '读 a.txt' },
    ];

    await runAgent(history, { model, tools, permission, cwd: dir });

    const toolMsg = history[3]!;
    expect(String(toolMsg.content)).toBe('hi'); // 真正读到了内容

    await rm(dir, { recursive: true, force: true });
  });

  it('上下文超预算时触发压缩（emit compact 且配对仍合法）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'easycli-comp-'));
    await writeFile(join(dir, 'a.txt'), 'x'.repeat(20000), 'utf8'); // 制造超长工具结果
    const tools = createToolRegistry();
    const bus = new EventBus();
    let compacted = false;
    let beforeTok = 0;
    let afterTok = 0;
    bus.on('compact', (e) => {
      compacted = true;
      const ev = e as { before?: number; after?: number };
      beforeTok = ev.before ?? 0;
      afterTok = ev.after ?? 0;
    });

    const permission = new PermissionManager({ settingsPath: join(dir, 'p3.json'), registry: tools });
    const call: ToolCall = { id: 'r1', name: 'read_file', arguments: { path: 'a.txt' } };
    const model = new ScriptedModel([
      { content: '读一下', toolCalls: [call] },
      { content: '完成', toolCalls: [] },
    ]);
    const compress: CompressOptions = {
      budgetTokens: 50,
      keepRecentTurns: 2,
      maxToolOutputChars: 200,
      summarizer: async () => 'SUMMARY',
    };
    const history: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '读 a.txt' },
    ];

    await runAgent(history, { model, tools, permission, bus, cwd: dir, compress });

    expect(compacted).toBe(true);
    expect(afterTok).toBeLessThanOrEqual(beforeTok);
    // 规范 history 的配对仍合法（压缩只动了「发给模型的副本」）
    const valid = (() => {
      for (let i = 0; i < history.length; i++) {
        const m = history[i]!;
        if (m.role === 'assistant' && Array.isArray(m.content)) {
          for (const b of m.content) {
            if (b.type === 'tool_call' && !history.slice(i + 1).some((x) => x.role === 'tool' && x.tool_call_id === b.id))
              return false;
          }
        }
      }
      return true;
    })();
    expect(valid).toBe(true);

    await rm(dir, { recursive: true, force: true });
  });
});
