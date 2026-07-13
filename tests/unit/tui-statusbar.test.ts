import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { createAppStore } from '../../src/tui/store';
import { StatusBar } from '../../src/tui/components/StatusBar';

// Phase B：StatusBar.tsx 字段等价性（lastFrame 帧断言，脱离真实 TTY）。
// 对齐旧 src/cli/statusbar.ts 的字段顺序与 ` · ` 分隔。

function frameOf(store: ReturnType<typeof createAppStore>): string {
  const { lastFrame } = render(React.createElement(StatusBar, { store }));
  return lastFrame() ?? '';
}

describe('StatusBar.tsx', () => {
  it('渲染 模型·分支·成本·时长·模式 全字段（默认不显示 ctx）', () => {
    const store = createAppStore({ model: 'agnes-2.0', branch: 'main' });
    store.getState().setStatus({ tokenText: '~1,500 tok' });
    const frame = frameOf(store);
    expect(frame).toContain('agnes-2.0');
    expect(frame).toContain('main');
    expect(frame).toContain('~1,500 tok');
    expect(frame).toContain('正常');
    expect(frame).toContain('·');
    expect(frame).not.toContain('ctx');
  });

  it('showCtx 打开时显示 ctx%', () => {
    const store = createAppStore({ model: 'm', branch: 'b' });
    store.getState().setStatus({ showCtx: true, ctxPct: 42 });
    expect(frameOf(store)).toContain('42% ctx');
  });

  it('plan 模式显示「规划」', () => {
    const store = createAppStore({ model: 'm', branch: 'b', mode: 'plan' });
    expect(frameOf(store)).toContain('规划');
  });

  it('--no-statusline（enabled=false）整条不渲染', () => {
    const store = createAppStore({ model: 'm', branch: 'b', statuslineEnabled: false });
    expect(frameOf(store).trim()).toBe('');
  });
});
