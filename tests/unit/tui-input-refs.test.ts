import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { splitRefs, currentRefToken, filterFiles, completeFileRef } from '../../src/tui/input-editor';
import { createAppStore } from '../../src/tui/store';
import { InputBox } from '../../src/tui/components/InputBox';

const tick = () => new Promise((r) => setTimeout(r, 20));

describe('input-editor @引用纯函数', () => {
  it('splitRefs 切分 @token 片段', () => {
    expect(splitRefs('帮 @src/a.ts 改').map((s) => [s.value, s.ref])).toEqual([
      ['帮 ', false],
      ['@src/a.ts', true],
      [' 改', false],
    ]);
  });

  it('currentRefToken 取光标前未结束的 @token', () => {
    expect(currentRefToken('@sr', 3)).toBe('@sr');
    expect(currentRefToken('@sr ', 4)).toBeNull();
    expect(currentRefToken('a@sr', 4)).toBe('@sr');
  });

  it('filterFiles 按子串筛选（空 query 返回全部）', () => {
    expect(filterFiles('@log', ['src/a.ts', 'src/login.ts'])).toEqual(['src/login.ts']);
    expect(filterFiles('@', ['a.ts', 'b.ts'])).toEqual(['a.ts', 'b.ts']);
  });

  it('completeFileRef 补全并补空格', () => {
    expect(completeFileRef('@lo', 3, 'src/login.ts')).toBe('@src/login.ts ');
  });
});

describe('InputBox @引用渲染与下拉', () => {
  it('输入 @token 时帧中出现文件路径候选下拉', async () => {
    const store = createAppStore({ height: 24 });
    const { stdin, lastFrame } = render(
      React.createElement(InputBox, {
        store,
        prompt: '❯ ',
        commands: [],
        history: [],
        fileRefs: ['src/auth/login.ts', 'src/auth/jwt.ts'],
        onSubmit: () => {},
        onInterrupt: () => {},
      }),
    );
    await tick();
    stdin.write('@log');
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('@src/auth/login.ts');
  });

  it('普通文本输入不受影响（仍走原有提交路径）', async () => {
    const store = createAppStore({ height: 24 });
    const onSubmit = (line: string) => {
      expect(line).toBe('hi');
    };
    const { stdin } = render(
      React.createElement(InputBox, {
        store,
        prompt: '❯ ',
        commands: [],
        history: [],
        fileRefs: ['src/auth/login.ts'],
        onSubmit,
        onInterrupt: () => {},
      }),
    );
    await tick();
    stdin.write('hi');
    await tick();
    stdin.write('\r');
    await tick();
  });
});
