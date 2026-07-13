// TTY 集成冒烟：mountTui 等价の App 合成（Transcript/StatusLine/StatusBar/InputBox）+ store 購読。
// 単体テストでは各コンポーネントを個別に検証済み；ここでは「App が子を正しく配置し、
// store 更新が Ink 再描画を通して最終フレームに反映される」ことを確認する。

import React from 'react';
import { render } from 'ink-testing-library';
import { describe, it, expect } from 'vitest';
import { App } from '../../src/tui/App';
import { createAppStore } from '../../src/tui/store';
import { renderMarkdown } from '../../src/cli/markdown';
import { COMMANDS } from '../../src/cli/commands';
import { ui } from '../../src/cli/theme';

describe('App 合成 + store 購読', () => {
  it('initialTranscript 与状态栏渲染', () => {
    const store = createAppStore({
      model: 'gpt-4o',
      branch: '(main)',
      statuslineEnabled: true,
      initialTranscript: ['splash line'],
    });
    const { lastFrame } = render(
      React.createElement(App, {
        store,
        prompt: ui.prompt,
        commands: COMMANDS,
        history: [],
        markdown: renderMarkdown,
        onSubmit: () => {},
        onInterrupt: () => {},
        onExit: () => {},
      }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('splash line');
    // 状态栏：模型 · 分支
    expect(frame).toContain('gpt-4o');
    expect(frame).toContain('(main)');
  });

  it('一轮提交后 transcript 反映输入/正文/成本', async () => {
    const store = createAppStore({ model: 'gpt-4o', branch: '(main)', statuslineEnabled: true });
    const { lastFrame } = render(
      React.createElement(App, {
        store,
        prompt: ui.prompt,
        commands: COMMANDS,
        history: [],
        markdown: renderMarkdown,
        onSubmit: () => {},
        onInterrupt: () => {},
        onExit: () => {},
      }),
    );
    // 模拟一轮：用户输入 → 流式正文 → 定稿 → 结束
    store.getState().commitUserTurn([ui.prompt + 'hi', '']);
    store.getState().pushText('hello world');
    store.getState().commitTurnDisplay(['hello world'], ['💰 $0.01']);
    store.getState().finishTurn();
    // Ink 在 store 变更后异步排定再描画，等一拍让帧刷新（stdin 驱动以外の直接更新）。
    await new Promise((r) => setTimeout(r, 20));

    const frame = lastFrame() ?? '';
    expect(frame).toContain('hi'); // 用户输入框行
    expect(frame).toContain('hello world'); // 渲染后的正文
    expect(frame).toContain('💰 $0.01'); // 成本行
  });

  it('resize → setSize 反映在 store', () => {
    const store = createAppStore({ model: 'm', branch: 'b', statuslineEnabled: false });
    render(
      React.createElement(App, {
        store,
        prompt: ui.prompt,
        commands: COMMANDS,
        history: [],
        markdown: renderMarkdown,
        onSubmit: () => {},
        onInterrupt: () => {},
        onExit: () => {},
      }),
    );
    expect(store.getState().width).toBeGreaterThan(0);
    store.getState().setSize(123, 45);
    expect(store.getState().width).toBe(123);
    expect(store.getState().height).toBe(45);
  });
});
