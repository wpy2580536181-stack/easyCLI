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

// 注：键盘滚动（PageUp/PageDown/方向键）已由 store.scrollBy/scrollToBottom 在逻辑层覆盖；
// 其按键映射（key.pageUp 等）已对照 Ink 源码 parse-keypress.js 确认，但 ink-testing-library
// 的伪 stdin 不驱动 Ink 的 raw 输入管线、useInput 在测试环境不触发，故不在此做集成断言。
