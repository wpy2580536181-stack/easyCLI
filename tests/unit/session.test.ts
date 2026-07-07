import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SessionStore,
  extractConversation,
  withSystem,
  AUTOSAVE_NAME,
} from '../../src/core/session/store';
import type { ChatMessage } from '../../src/core/chatmodel/types';
import { estimateHistoryTokens, type CompressOptions } from '../../src/core/memory/compressor';

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'easycli-session-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('extractConversation / withSystem', () => {
  it('extractConversation 去掉 system 消息', () => {
    const h: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ];
    expect(extractConversation(h).map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('withSystem 把对话流重新接回 system 提示', () => {
    const conv: ChatMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ];
    const full = withSystem(conv, 'SYS');
    expect(full[0]).toEqual({ role: 'system', content: 'SYS' });
    expect(full.length).toBe(3);
  });
});

describe('SessionStore 存读删', () => {
  it('save 后 load 可还原对话流', async () => {
    const store = new SessionStore(dir);
    const msgs: ChatMessage[] = [
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你好，有什么可以帮你？' },
      { role: 'tool', content: 'ls 输出', tool_call_id: 't1', name: 'bash' },
    ];
    await store.save('demo', msgs);
    expect(store.exists('demo')).toBe(true);
    const loaded = store.load('demo');
    expect(loaded).not.toBeNull();
    expect(loaded!.length).toBe(3);
    expect(loaded![0]).toEqual({ role: 'user', content: '你好' });
    expect(loaded![2]?.tool_call_id).toBe('t1');
  });

  it('load 不存在的会话返回 null', async () => {
    const store = new SessionStore(dir);
    expect(store.load('nope')).toBeNull();
  });

  it('list 返回按更新时间倒序的元数据', async () => {
    // 用独立子目录，避免被本 describe 其它用例写入的会话污染
    const isolated = await mkdtemp(join(tmpdir(), 'easycli-session-list-'));
    try {
      const store = new SessionStore(isolated);
      await store.save('old', [{ role: 'user', content: 'a' }]);
      // 制造时间差
      await new Promise((r) => setTimeout(r, 5));
      await store.save('new', [
        { role: 'user', content: 'b' },
        { role: 'assistant', content: 'c' },
      ]);
      const list = store.list();
      expect(list.map((s) => s.name)).toEqual(['new', 'old']);
      expect(list.find((s) => s.name === 'new')!.messageCount).toBe(2);
      expect(list.find((s) => s.name === 'old')!.messageCount).toBe(1);
    } finally {
      await rm(isolated, { recursive: true, force: true });
    }
  });

  it('remove 删除会话', async () => {
    const store = new SessionStore(dir);
    await store.save('todelete', [{ role: 'user', content: 'x' }]);
    expect(store.remove('todelete')).toBe(true);
    expect(store.exists('todelete')).toBe(false);
    expect(store.remove('todelete')).toBe(false);
  });

  it('文件名做安全化，防路径穿越', async () => {
    const store = new SessionStore(dir);
    const dirty = '../../etc/passwd/name with?';
    await store.save(dirty, [{ role: 'user', content: 'safe' }]);
    // 仍能按原名读回（pathFor 两边都做了同样的安全化）
    expect(store.exists(dirty)).toBe(true);
    expect(store.load(dirty)?.[0]?.content).toBe('safe');
  });

  it('AUTOSAVE_NAME 是保留名', () => {
    expect(AUTOSAVE_NAME).toBe('autosave');
  });
});

describe('SessionStore 保存时复用压缩限长', () => {
  it('超预算的长会话经 compress 后，落盘会话 token 数被限制在内', async () => {
    const store = new SessionStore(dir);
    const opts: CompressOptions = {
      budgetTokens: 2000,
      keepRecentTurns: 4,
      maxToolOutputChars: 200,
    };
    // 构造 40 轮、每轮含一条超长 tool 结果，远超预算
    const big: ChatMessage[] = [];
    for (let i = 0; i < 40; i++) {
      big.push({ role: 'user', content: `问题${i}` });
      big.push({ role: 'tool', content: 'x'.repeat(600), tool_call_id: `t${i}`, name: 'bash' });
    }
    const rawTokens = estimateHistoryTokens(big);
    expect(rawTokens).toBeGreaterThan(opts.budgetTokens);

    await store.save('big', big, opts);
    const loaded = store.load('big')!;
    expect(loaded).not.toBeNull();
    // 压缩后落盘会话被限制在内（含 system 也不应超太多；这里纯对话流）
    expect(estimateHistoryTokens(loaded)).toBeLessThanOrEqual(opts.budgetTokens);
  });

  it('小会话（预算内）保存后长度不变（压缩提前返回）', async () => {
    const store = new SessionStore(dir);
    const small: ChatMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello there' },
    ];
    const opts: CompressOptions = { budgetTokens: 8000, keepRecentTurns: 4, maxToolOutputChars: 1500 };
    await store.save('small', small, opts);
    expect(store.load('small')!.length).toBe(2);
  });
});
