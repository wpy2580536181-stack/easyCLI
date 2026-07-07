import { describe, expect, it, vi } from 'vitest';
import { FallbackChatModel } from '../../src/core/chatmodel/fallback';
import type { ChatModel, CompleteOptions, CompleteResult } from '../../src/core/chatmodel/types';

class ScriptedModel implements ChatModel {
  readonly id: string;
  calls = 0;
  constructor(id: string, private readonly result: CompleteResult | null, private readonly err?: Error) {
    this.id = id;
  }
  async complete(_opts: CompleteOptions): Promise<CompleteResult> {
    this.calls++;
    if (this.err) throw this.err;
    return this.result!;
  }
}

describe('FallbackChatModel', () => {
  const ok: CompleteResult = { content: 'ok', toolCalls: [] };

  it('主模型成功时直接返回，不触碰备用', async () => {
    const primary = new ScriptedModel('p', ok);
    const fb = new ScriptedModel('f', ok);
    const m = new FallbackChatModel(primary, fb);
    const r = await m.complete({ messages: [] });
    expect(r.content).toBe('ok');
    expect(primary.calls).toBe(1);
    expect(fb.calls).toBe(0);
    expect(m.id).toBe('p→f');
  });

  it('主模型抛错时自动切换备用，并触发 onSwitch', async () => {
    const primary = new ScriptedModel('p', null, new Error('boom'));
    const fb = new ScriptedModel('f', ok);
    const onSwitch = vi.fn();
    const m = new FallbackChatModel(primary, fb, { onSwitch });
    const r = await m.complete({ messages: [] });
    expect(r.content).toBe('ok');
    expect(fb.calls).toBe(1);
    expect(onSwitch).toHaveBeenCalledWith('p', 'f', expect.any(Error));
  });

  it('用户中断（AbortError）不降级，直接向上抛', async () => {
    const primary = new ScriptedModel('p', null, Object.assign(new Error('aborted'), { name: 'AbortError' }));
    const fb = new ScriptedModel('f', ok);
    const onSwitch = vi.fn();
    const m = new FallbackChatModel(primary, fb, { onSwitch });
    const signal = AbortSignal.abort();
    await expect(m.complete({ messages: [], signal })).rejects.toThrow('aborted');
    expect(fb.calls).toBe(0); // 备用绝不被调用
    expect(onSwitch).not.toHaveBeenCalled();
  });

  it('备用也失败则异常照常冒泡', async () => {
    const primary = new ScriptedModel('p', null, new Error('p-fail'));
    const fb = new ScriptedModel('f', null, new Error('f-fail'));
    const m = new FallbackChatModel(primary, fb);
    await expect(m.complete({ messages: [] })).rejects.toThrow('f-fail');
  });
});
