import { describe, it, expect } from 'vitest';
import { StreamRenderer, type OutputSink } from '../../src/cli/renderer';

/** 可注入的字符串输出槽，用于断言渲染行为（不依赖真实终端） */
class StringSink implements OutputSink {
  buf = '';
  write(s: string): void {
    this.buf += s;
  }
}

describe('StreamRenderer - 正文流式', () => {
  it('连续 push 直接拼接，无多余换行/状态', () => {
    const sink = new StringSink();
    const r = new StreamRenderer((s) => s, sink);
    r.push('你好');
    r.push('世界');
    expect(sink.buf).toBe('你好世界');
  });

  it('着色函数被应用到正文', () => {
    const sink = new StringSink();
    const r = new StreamRenderer((s) => `[${s}]`, sink);
    r.push('x');
    expect(sink.buf).toBe('[x]');
  });
});

describe('StreamRenderer - 状态行原地刷新（更顺滑的关键）', () => {
  it('status 后 push：正文恢复时擦除状态行，正文不被切碎', () => {
    const sink = new StringSink();
    const r = new StreamRenderer((s) => s, sink);
    r.status('🔧 调用工具 bash');
    r.push('模型继续输出');
    // 状态文本出现，但紧接着被 \r\x1b[K 擦除，再续写正文
    expect(sink.buf).toContain('🔧 调用工具 bash');
    expect(sink.buf).toContain('\r\x1b[K');
    expect(sink.buf.endsWith('模型继续输出')).toBe(true);
    // 状态文本只出现一次（没有被重复打印成碎片）
    expect((sink.buf.match(/🔧/g) ?? []).length).toBe(1);
  });

  it('连续两条 status：第二条原地覆盖第一条（仍只一条屏幕状态行）', () => {
    const sink = new StringSink();
    const r = new StreamRenderer((s) => s, sink);
    r.status('a');
    r.status('b');
    r.newline();
    // 两条状态文本都在缓冲里（覆盖是屏幕行为），但末尾用 erase 收尾
    expect(sink.buf).toContain('a');
    expect(sink.buf).toContain('b');
    expect(sink.buf.endsWith('\r\x1b[K\n')).toBe(true);
    // 出现两次 erase：status('b') 覆盖一条 + newline 收尾一条
    expect((sink.buf.match(/\r\x1b\[K/g) ?? []).length).toBe(2);
  });

  it('末尾若是状态行，newline 会先擦掉它，不留半句状态', () => {
    const sink = new StringSink();
    const r = new StreamRenderer((s) => s, sink);
    r.status('加载中');
    r.newline();
    expect(sink.buf).toContain('加载中');
    expect(sink.buf.endsWith('\r\x1b[K\n')).toBe(true);
  });

  it('纯正文 + newline 只补一个换行，无需擦除', () => {
    const sink = new StringSink();
    const r = new StreamRenderer((s) => s, sink);
    r.push('hi');
    r.newline();
    expect(sink.buf).toBe('hi\n');
    expect((sink.buf.match(/\r\x1b\[K/g) ?? []).length).toBe(0);
  });
});
