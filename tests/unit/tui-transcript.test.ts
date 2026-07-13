import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { createAppStore } from '../../src/tui/store';
import { Transcript } from '../../src/tui/components/Transcript';
import { cropLines, buildVisibleLines } from '../../src/tui/transcript';

// Phase D：Transcript 视口裁剪 + 流式正文渲染等价性。

describe('transcript 纯函数', () => {
  it('cropLines 超长从顶部裁剪，保留末尾 N 行', () => {
    expect(cropLines(['a', 'b', 'c', 'd'], 2)).toEqual(['c', 'd']);
    expect(cropLines(['a', 'b'], 5)).toEqual(['a', 'b']);
    expect(cropLines(['a'], 0)).toEqual([]);
  });

  it('buildVisibleLines 按 transcript→userTurn→body 顺序拼接后裁剪', () => {
    const out = buildVisibleLines({
      transcriptLines: ['h1', 'h2'],
      userTurn: ['u1'],
      bodyLines: ['b1', 'b2'],
      maxRows: 3,
    });
    expect(out).toEqual(['u1', 'b1', 'b2']);
  });
});

describe('Transcript.tsx', () => {
  it('渲染 transcriptLines + userTurn + 流式正文', () => {
    const store = createAppStore({
      initialTranscript: ['— 欢迎 —'],
      height: 40,
    });
    store.getState().commitUserTurn(['❯ 问题']);
    store.getState().pushText('回答内容');
    const { lastFrame } = render(React.createElement(Transcript, { store }));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('欢迎');
    expect(frame).toContain('问题');
    expect(frame).toContain('回答内容');
  });

  it('commitTurnDisplay 后正文定稿进 transcriptLines，userTurn 清空', () => {
    const store = createAppStore({ height: 40 });
    store.getState().commitUserTurn(['❯ Q']);
    store.getState().pushText('A');
    // 模拟 bridge：把渲染好的正文行定稿
    store.getState().commitTurnDisplay(['A'], ['¥0.001']);
    store.getState().finishTurn();
    const s = store.getState();
    expect(s.userTurn).toEqual([]);
    expect(s.transcriptLines).toEqual(['❯ Q', 'A', '¥0.001']);
    expect(s.history.at(-1)).toEqual({ role: 'assistant', content: 'A' });
  });

  it('视口按 height - reservedRows 裁剪，超长丢弃顶部', () => {
    const many = Array.from({ length: 20 }, (_, i) => `line-${i}`);
    const store = createAppStore({ initialTranscript: many, height: 10 });
    const { lastFrame } = render(
      React.createElement(Transcript, { store, reservedRows: 3 }),
    );
    const frame = lastFrame() ?? '';
    // maxRows = 10 - 3 = 7 → 仅末 7 行（line-13..line-19）
    expect(frame).toContain('line-19');
    expect(frame).toContain('line-13');
    expect(frame).not.toContain('line-12');
    expect(frame).not.toContain('line-0');
  });
});
