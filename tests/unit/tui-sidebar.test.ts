import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { createAppStore } from '../../src/tui/store';
import { Sidebar } from '../../src/tui/components/Sidebar';
import { TopStatusBar } from '../../src/tui/components/TopStatusBar';

describe('Sidebar', () => {
  it('宽屏渲染 FILES 与 SESSIONS 面板', () => {
    const store = createAppStore({
      width: 120,
      sidebarOpen: true,
      files: [{ path: 'a.ts', status: 'M' }],
      sessions: [{ id: '1', title: 's1', active: true }],
    });
    const f = render(React.createElement(Sidebar, { store }));
    const frame = f.lastFrame() ?? '';
    expect(frame).toContain('FILES');
    expect(frame).toContain('SESSIONS');
    expect(frame).toContain('a.ts');
  });

  it('窄屏（<90 列）不渲染侧栏（尺寸自适应）', () => {
    const store = createAppStore({ width: 80 });
    const { lastFrame } = render(React.createElement(Sidebar, { store }));
    expect((lastFrame() ?? '').trim()).toBe('');
  });

  it('sidebarOpen=false 不渲染', () => {
    const store = createAppStore({ width: 120, sidebarOpen: true });
    store.getState().toggleSidebar();
    const { lastFrame } = render(React.createElement(Sidebar, { store }));
    expect((lastFrame() ?? '').trim()).toBe('');
  });
});

describe('TopStatusBar', () => {
  it('渲染模型与模式（正常）', () => {
    const store = createAppStore({ model: 'gpt-4o', branch: '(main)' });
    store.getState().setStatus({ tokenText: '~1,500 tok' });
    const { lastFrame } = render(React.createElement(TopStatusBar, { store }));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('gpt-4o');
    expect(frame).toContain('(main)');
    expect(frame).toContain('正常');
  });

  it('plan 模式显示「规划」', () => {
    const store = createAppStore({ model: 'm', branch: 'b', mode: 'plan' });
    const { lastFrame } = render(React.createElement(TopStatusBar, { store }));
    expect((lastFrame() ?? '').toContain('规划')).toBe(true);
  });
});
