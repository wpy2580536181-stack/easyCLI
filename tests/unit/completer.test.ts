import { describe, it, expect } from 'vitest';
import { completeLine, SLASH_COMMANDS } from '../../src/cli/completer';

describe('completeLine - slash 命令补全', () => {
  it('"/cle" 补全到 /clear', () => {
    const r = completeLine('/cle');
    expect(r.hits).toEqual(['/clear']);
    expect(r.line).toBe('/cle');
  });

  it('"/" 列出全部 slash 命令（带 / 前缀）', () => {
    const r = completeLine('/');
    expect(r.hits.length).toBe(SLASH_COMMANDS.length);
    expect(r.hits.every((h) => h.startsWith('/'))).toBe(true);
  });

  it('精确匹配时只返回自身', () => {
    const r = completeLine('/exit');
    expect(r.hits).toEqual(['/exit']);
  });

  it('无匹配返回空数组', () => {
    const r = completeLine('/zzz');
    expect(r.hits).toEqual([]);
  });

  it('多候选时返回所有前缀匹配（按 SLASH_COMMANDS 顺序）', () => {
    const r = completeLine('/s');
    // skill / skills / save / session / sessions / sessions... 实际以 s 开头的：save, session, sessions, skill, skills
    expect(r.hits).toContain('/save');
    expect(r.hits).toContain('/skill');
    expect(r.hits).toContain('/skills');
    expect(r.hits).toContain('/session');
    expect(r.hits).toContain('/sessions');
  });
});

describe('completeLine - 历史补全（普通文本）', () => {
  const history = ['如何用 ts 写单测', '如何用 ts 写 CLI', 'python 怎么跑'];

  it('按前缀从历史上补全', () => {
    const r = completeLine('如何用 ts', SLASH_COMMANDS, history);
    expect(r.hits).toEqual(['如何用 ts 写单测', '如何用 ts 写 CLI']);
  });

  it('精确等于某条历史时不返回它自身', () => {
    const r = completeLine('python 怎么跑', SLASH_COMMANDS, history);
    expect(r.hits).toEqual([]);
  });

  it('无前缀匹配返回空', () => {
    const r = completeLine('xyz', SLASH_COMMANDS, history);
    expect(r.hits).toEqual([]);
  });

  it('默认无历史时普通文本返回空', () => {
    const r = completeLine('随便说点什么');
    expect(r.hits).toEqual([]);
  });
});
