import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { createAppStore } from '../../src/tui/store';
import { Transcript } from '../../src/tui/components/Transcript';
import { buildVisibleLines } from '../../src/tui/transcript';

// 应用内滚动：scrollOffset 决定视口窗口（从底部上滚 N 行），与终端滚动缓冲区解耦。

describe('buildVisibleLines 滚动窗口', () => {
  const lines = Array.from({ length: 20 }, (_, i) => `L${i}`);

  it('offset=0 贴底显示末尾 maxRows 行', () => {
    const out = buildVisibleLines({ transcriptLines: lines, userTurn: [], bodyLines: [], maxRows: 7 });
    expect(out).toEqual(['L13', 'L14', 'L15', 'L16', 'L17', 'L18', 'L19']);
  });

  it('offset 上滚显示顶部窗口（并夹取到 [0,total-maxRows]）', () => {
    const top = buildVisibleLines({ transcriptLines: lines, userTurn: [], bodyLines: [], maxRows: 7, scrollOffset: 999 });
    expect(top).toEqual(['L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6']);
    const mid = buildVisibleLines({ transcriptLines: lines, userTurn: [], bodyLines: [], maxRows: 7, scrollOffset: 6 });
    expect(mid).toEqual(['L7', 'L8', 'L9', 'L10', 'L11', 'L12', 'L13']);
  });

  it('内容不足 maxRows 时整段显示，不受 offset 影响', () => {
    const out = buildVisibleLines({ transcriptLines: ['a', 'b'], userTurn: [], bodyLines: [], maxRows: 10, scrollOffset: 99 });
    expect(out).toEqual(['a', 'b']);
  });
});

describe('store.scrollBy / scrollToBottom', () => {
  it('按视口夹取并回底', () => {
    const store = createAppStore({ height: 10 });
    store.getState().setTranscript(Array.from({ length: 30 }, (_, i) => `x${i}`));
    // maxRows = height-4 = 6, total=30 → maxOff=24
    store.getState().scrollBy(Number.MAX_SAFE_INTEGER);
    expect(store.getState().scrollOffset).toBe(24);
    store.getState().scrollBy(-5);
    expect(store.getState().scrollOffset).toBe(19);
    store.getState().scrollToBottom();
    expect(store.getState().scrollOffset).toBe(0);
  });

  it('commitUserTurn 新一轮开始自动回底', () => {
    const store = createAppStore({ height: 10 });
    store.getState().setTranscript(Array.from({ length: 30 }, (_, i) => `x${i}`));
    store.getState().scrollBy(20);
    expect(store.getState().scrollOffset).toBe(20);
    store.getState().commitUserTurn(['❯ hi']);
    expect(store.getState().scrollOffset).toBe(0);
  });
});

describe('Transcript.tsx 上滚后显示顶部历史', () => {
  it('scrollOffset 大时渲染开头行而非末尾', () => {
    const many = Array.from({ length: 20 }, (_, i) => `line-${i}`);
    const store = createAppStore({ initialTranscript: many, height: 10 });
    store.getState().scrollBy(Number.MAX_SAFE_INTEGER); // 跳顶
    const { lastFrame } = render(React.createElement(Transcript, { store, reservedRows: 4 }));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('line-0');
    expect(frame).not.toContain('line-19');
  });
});

describe('滚动修复：流式正文用渲染后行数夹取', () => {
  // 回归：流式期间 assistantBuffer 未渲染时只有少数原始换行，若 scrollBy 据此夹取 maxOff
  // 会过小，长回复开头（"被滚掉的消息"）永远滚不到。修复后由 App 传入 markdown 渲染后的真实总行。
  const height = 20;
  const maxRows = height - 4; // 16
  const history = Array.from({ length: 10 }, (_, i) => `h${i}`);
  // markdown 渲染：原始 2 行 → 渲染后 80 行（每行展开 40 行）
  const md = (s: string): string[] =>
    s.split('\n').flatMap((l) => Array.from({ length: 40 }, (_, i) => `${l}-r${i}`));

  it('旧估算（无 totalOverride）把 maxOff 夹成 0，长回复开头滚不到', () => {
    const store = createAppStore({ height });
    store.getState().setTranscript(history);
    store.getState().pushText('A\nB'); // 原始仅 2 行
    // 旧路径：scrollBy 用原始 \n 切分，body=2 → total=12 → maxOff=0
    store.getState().scrollBy(8);
    expect(store.getState().scrollOffset).toBe(0);
    const body = md(store.getState().assistantBuffer);
    const vis = buildVisibleLines({ transcriptLines: history, userTurn: [], bodyLines: body, maxRows, scrollOffset: 0 });
    // 贴底只显示回复尾部，看不到回复开头（h0 在 index 0，不在视口）
    expect(vis[0]).not.toContain('h0');
  });

  it('传真实渲染总行后，maxOff 足够大，可滚到回复开头', () => {
    const store = createAppStore({ height });
    store.getState().setTranscript(history);
    store.getState().pushText('A\nB');
    const body = md(store.getState().assistantBuffer);
    const trueTotal = history.length + 0 + body.length; // 90
    const step = Math.max(3, Math.floor((height - 4) / 2)); // 8
    for (let i = 0; i < 20; i++) store.getState().scrollBy(step, trueTotal);
    // 应夹到真实 maxOff（而非旧的小值），从而能滚到顶部、看到回复开头
    expect(store.getState().scrollOffset).toBe(trueTotal - maxRows); // 74
    const vis = buildVisibleLines({
      transcriptLines: history,
      userTurn: [],
      bodyLines: body,
      maxRows,
      scrollOffset: store.getState().scrollOffset,
    });
    expect(vis[0]).toContain('h0');
  });
});

// 注：键盘滚动（PageUp/PageDown/方向键）已由 store.scrollBy/scrollToBottom 在逻辑层覆盖；
// 其按键映射（key.pageUp 等）已对照 Ink 源码 parse-keypress.js 确认，但 ink-testing-library
// 的伪 stdin 不驱动 Ink 的 raw 输入管线、useInput 在测试环境不触发，故不在此做集成断言。
