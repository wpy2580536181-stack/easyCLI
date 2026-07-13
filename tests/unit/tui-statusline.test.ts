import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { createAppStore } from '../../src/tui/store';
import { StatusLine } from '../../src/tui/components/StatusLine';

// Phase C：StatusLine.tsx footer 动画等价性。
// 对齐旧 src/cli/status.ts 的 footerLine 文案与 idle 隐藏行为。

function frameOf(store: ReturnType<typeof createAppStore>): string {
  const { lastFrame } = render(React.createElement(StatusLine, { store }));
  return lastFrame() ?? '';
}

describe('StatusLine.tsx', () => {
  it('idle 态高度 0（不渲染任何内容）', () => {
    const store = createAppStore();
    expect(frameOf(store).trim()).toBe('');
  });

  it('思考态显示 思考中… 与 (Ns)，无 tokens', () => {
    const store = createAppStore();
    store.getState().beginAnim('');
    const frame = frameOf(store);
    expect(frame).toContain('思考中…');
    expect(frame).toMatch(/\(\d+s\)/);
    expect(frame).not.toContain('tokens');
  });

  it('工具态显示 🔧 调用工具 名称；toolDone 显示 ✓ 名称', () => {
    const store = createAppStore();
    store.getState().beginAnim('');
    store.getState().toolStart('read_file');
    expect(frameOf(store)).toContain('🔧 调用工具 read_file');
    store.getState().toolDone('read_file', true);
    expect(frameOf(store)).toContain('✓ read_file');
  });

  it('流式态显示 生成回复中… 与 ↓ N tokens', () => {
    const store = createAppStore();
    store.getState().beginAnim('');
    store.getState().pushText('你好世界'); // 4 CJK ≈ 4 tokens
    const frame = frameOf(store);
    expect(frame).toContain('生成回复中…');
    expect(frame).toMatch(/↓ \d+ tokens/);
  });

  it('cachePct 显示 cache N%', () => {
    const store = createAppStore();
    store.getState().beginAnim('');
    store.getState().setCache(85);
    expect(frameOf(store)).toContain('cache 85%');
  });
});
