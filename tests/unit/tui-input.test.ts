import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import type { CommandMeta } from '../../src/cli/commands';
import { filterCommands, decideEnter, wrapIndex } from '../../src/tui/input-editor';
import { createAppStore } from '../../src/tui/store';
import { InputBox } from '../../src/tui/components/InputBox';
import { Approval } from '../../src/tui/components/Approval';

const CMDS: CommandMeta[] = [
  { name: 'exit', description: '退出' },
  { name: 'export', description: '导出会话' },
  { name: 'help', description: '帮助' },
];

const tick = () => new Promise((r) => setTimeout(r, 20));

describe('input-editor 纯函数', () => {
  it('filterCommands 按全名包含子串筛选', () => {
    expect(filterCommands('/ex', CMDS).map((c) => c.name)).toEqual(['exit', 'export']);
    expect(filterCommands('/help', CMDS).map((c) => c.name)).toEqual(['help']);
    expect(filterCommands('hello', CMDS)).toEqual([]);
  });

  it('decideEnter：唯一匹配→execute', () => {
    expect(decideEnter('/help', CMDS, 0)).toEqual({ kind: 'execute', line: '/help' });
  });

  it('decideEnter：多匹配非全名→fill 高亮项', () => {
    expect(decideEnter('/ex', CMDS, 1)).toEqual({ kind: 'fill', input: '/export ' });
  });

  it('decideEnter：多匹配但已输全名→execute', () => {
    expect(decideEnter('/exit', CMDS, 0)).toEqual({ kind: 'execute', line: '/exit' });
  });

  it('decideEnter：普通文本非空→submit，空→noop', () => {
    expect(decideEnter('hi', CMDS, 0)).toEqual({ kind: 'submit', line: 'hi' });
    expect(decideEnter('   ', CMDS, 0)).toEqual({ kind: 'noop' });
  });

  it('wrapIndex 环形移动', () => {
    expect(wrapIndex(0, -1, 3)).toBe(2);
    expect(wrapIndex(2, 1, 3)).toBe(0);
  });
});

describe('InputBox.tsx', () => {
  it('键入普通文本，Enter 提交并清空', async () => {
    const store = createAppStore({ height: 24 });
    const onSubmit = vi.fn();
    const { stdin } = render(
      React.createElement(InputBox, {
        store,
        prompt: '❯ ',
        commands: CMDS,
        history: [],
        onSubmit,
        onInterrupt: () => {},
      }),
    );
    await tick();
    stdin.write('hi');
    await tick();
    expect(store.getState().input).toBe('hi');
    stdin.write('\r');
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('hi');
    expect(store.getState().input).toBe('');
  });

  it('键入 / 前缀实时筛选出下拉命令', async () => {
    const store = createAppStore({ height: 24 });
    const { stdin, lastFrame } = render(
      React.createElement(InputBox, {
        store,
        prompt: '❯ ',
        commands: CMDS,
        history: [],
        onSubmit: () => {},
        onInterrupt: () => {},
      }),
    );
    await tick();
    stdin.write('/ex');
    await tick();
    expect(store.getState().dropdown.map((c) => c.name)).toEqual(['exit', 'export']);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('/exit');
    expect(frame).toContain('/export');
  });

  // Ctrl+C 已移至 App.tsx 全局捕获（busy 时也需中断），InputBox 不再处理。
});

describe('Approval.tsx', () => {
  it('渲染提问；键入 y + Enter 兑现 y', async () => {
    const store = createAppStore();
    const p = store.getState().requestApproval('允许执行? (y/n/a)');
    const { stdin, lastFrame } = render(React.createElement(Approval, { store }));
    await tick();
    expect(lastFrame() ?? '').toContain('允许执行?');
    stdin.write('y');
    await tick();
    stdin.write('\r');
    await expect(p).resolves.toBe('y');
    expect(store.getState().approval).toBeNull();
  });

  it('防抖窗口内首回车被忽略', async () => {
    const store = createAppStore();
    let resolved = false;
    const p = store.getState().requestApproval('确认?', { debounceMs: 500 });
    void p.then(() => {
      resolved = true;
    });
    const { stdin } = render(React.createElement(Approval, { store }));
    await tick();
    stdin.write('\r'); // 窗口内首回车 → 忽略
    await tick();
    expect(resolved).toBe(false);
    expect(store.getState().approval).not.toBeNull();
  });
});
