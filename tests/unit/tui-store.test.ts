import { describe, it, expect } from 'vitest';
import { createAppStore } from '../../src/tui/store';
import { createBridge } from '../../src/tui/bridge';

// Phase A 冒烟测试：store 单一状态源 + bridge 节流缓冲的核心不变量。
// 目标：证明 TUI 状态层可脱离终端单测（现状 repl.ts 主循环做不到）。

describe('AppStore', () => {
  it('初始状态可注入 model/branch/history', () => {
    const store = createAppStore({
      model: 'gpt-x',
      branch: 'main',
      initialHistory: [{ role: 'user', content: 'hi' }],
    });
    const s = store.getState();
    expect(s.model).toBe('gpt-x');
    expect(s.branch).toBe('main');
    expect(s.history).toHaveLength(1);
    expect(s.anim.mode).toBe('idle');
    expect(s.state).toBe('input');
  });

  it('pushText 累积流式正文并切到 stream 动画', () => {
    const store = createAppStore();
    store.getState().pushText('Hel');
    store.getState().pushText('lo');
    const s = store.getState();
    expect(s.assistantBuffer).toBe('Hello');
    expect(s.anim.mode).toBe('stream');
    expect(s.anim.estTokens).toBeGreaterThan(0);
  });

  it('commitUserTurn → finishTurn 把 buffer 落盘为一条 assistant history', () => {
    const store = createAppStore();
    store.getState().commitUserTurn(['> question']);
    expect(store.getState().userTurn).toEqual(['> question']);
    expect(store.getState().anim.mode).toBe('thinking');

    store.getState().pushText('answer');
    store.getState().finishTurn();

    const s = store.getState();
    expect(s.assistantBuffer).toBe('');
    expect(s.userTurn).toEqual([]);
    expect(s.anim.mode).toBe('idle');
    expect(s.history.at(-1)).toEqual({ role: 'assistant', content: 'answer' });
  });

  it('requestApproval 返回 Promise，resolveApproval 兑现', async () => {
    const store = createAppStore();
    const p = store.getState().requestApproval('proceed?');
    expect(store.getState().approval?.question).toBe('proceed?');
    expect(store.getState().state).toBe('asking');

    store.getState().resolveApproval('y');
    await expect(p).resolves.toBe('y');
    expect(store.getState().approval).toBeNull();
    expect(store.getState().state).toBe('input');
  });

  it('setInput 约束 cursor 不越界；moveCursor 夹逼', () => {
    const store = createAppStore();
    store.getState().setInput('abc');
    store.getState().moveCursor(100);
    expect(store.getState().cursor).toBe(3);
    store.getState().moveCursor(-100);
    expect(store.getState().cursor).toBe(0);
  });
});

describe('Bridge 节流缓冲', () => {
  it('pushToken 累积、flush 后一次性 commit 到 store', async () => {
    const store = createAppStore();
    const bridge = createBridge(store, { flushMs: 10 });
    bridge.pushToken('a');
    bridge.pushToken('b');
    // flush 前尚未写入 store
    expect(store.getState().assistantBuffer).toBe('');
    await new Promise((r) => setTimeout(r, 25));
    expect(store.getState().assistantBuffer).toBe('ab');
    bridge.dispose();
  });

  it('onToolCall/onToolResult 先 flush 再切动画', async () => {
    const store = createAppStore();
    const bridge = createBridge(store, { flushMs: 1000 });
    bridge.pushToken('x');
    bridge.onToolCall('read_file');
    // onToolCall 强制 flush，无需等定时器
    expect(store.getState().assistantBuffer).toBe('x');
    expect(store.getState().anim.mode).toBe('tool');
    expect(store.getState().anim.label).toBe('🔧 调用工具 read_file');
    bridge.onToolResult('read_file', true);
    // toolDone 保持 tool 态并显示 ✓ 结果（对齐旧 status.ts）
    expect(store.getState().anim.mode).toBe('tool');
    expect(store.getState().anim.label).toBe('✓ read_file');
    bridge.dispose();
  });

  it('finishTurn flush 残留并落盘', () => {
    const store = createAppStore();
    const bridge = createBridge(store, { flushMs: 1000 });
    bridge.pushToken('done');
    bridge.finishTurn();
    expect(store.getState().history.at(-1)).toEqual({ role: 'assistant', content: 'done' });
    bridge.dispose();
  });
});
