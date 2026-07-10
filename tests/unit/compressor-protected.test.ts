import { describe, it, expect } from 'vitest';
import { compressHistory, type CompressOptions } from '../../src/core/memory/compressor';
import type { ChatMessage } from '../../src/core/chatmodel/types';

function msg(
  role: ChatMessage['role'],
  content: string | ChatMessage['content'],
  extra: Partial<ChatMessage> = {},
): ChatMessage {
  return { role, content, ...extra };
}

// maxToolOutputChars 设很大：让超长 tool 结果不被第1级裁剪，从而强制走到
// 第3级折叠，才能验证「protected 豁免 / 普通轮被折叠」的差异。
const baseOpts: CompressOptions = {
  budgetTokens: 100, // 极小预算，必触发压缩
  keepRecentTurns: 1,
  maxToolOutputChars: 5000,
};

function join(msgs: ChatMessage[]): string {
  return msgs
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join('\n');
}

describe('compressHistory 重要消息保护', () => {
  it('protected user 文本不被裁剪；普通中间轮的工具结果被折叠', async () => {
    const history: ChatMessage[] = [
      msg('system', 'sys'),
      msg('user', '记住：项目根目录是 /app', { protected: true }), // TURN A（pinned）
      msg('assistant', '好的'),
      msg('user', '普通任务A'), // TURN B（普通中间轮）
      msg('assistant', '我来'),
      msg('tool', 'a'.repeat(2000), { tool_call_id: '1', name: 'ls' }), // 折叠点
      msg('user', '最近一轮'), // TURN C（recent，保留）
      msg('assistant', '最近答'),
    ];
    const out = await compressHistory(history, baseOpts);
    const text = join(out);
    expect(text).toContain('记住：项目根目录是 /app'); // pinned 原样保留
    expect(text).toContain('已折叠工具结果'); // 普通中间轮被折叠
  });

  it('protected 整轮（含其 tool 结果）不被折叠；普通轮被折叠', async () => {
    const history: ChatMessage[] = [
      msg('system', 'sys'),
      msg('user', '重要：部署前必须跑 migration', { protected: true }), // TURN A
      msg('assistant', [{ type: 'tool_call', id: 't1', name: 'bash', arguments: {} }]),
      msg('tool', 'ran migration ok', { tool_call_id: 't1', name: 'bash' }), // TURN A 的一部分，应保留
      msg('user', '普通任务'), // TURN B（折叠）
      msg('assistant', [{ type: 'tool_call', id: 't2', name: 'bash', arguments: {} }]),
      msg('tool', 'y'.repeat(3000), { tool_call_id: 't2', name: 'bash' }),
      msg('user', '最近一轮'), // TURN C（recent）
      msg('assistant', '最近答'),
    ];
    const out = await compressHistory(history, baseOpts);
    const text = join(out);
    expect(text).toContain('重要：部署前必须跑 migration'); // protected 文本保留
    expect(text).toContain('ran migration ok'); // protected 轮的 tool 结果保留
    expect(text).toContain('已折叠工具结果'); // 普通轮被折叠
  });

  it('无 protected 时行为不变（普通超长中间轮仍折叠，最近轮保留）', async () => {
    const history: ChatMessage[] = [
      msg('system', 'sys'),
      msg('user', '普通问题'),
      msg('assistant', '答'),
      msg('tool', 'z'.repeat(3000), { tool_call_id: '1', name: 'ls' }),
      msg('user', '最近一轮'),
      msg('assistant', '最近答'),
    ];
    const out = await compressHistory(history, baseOpts);
    const text = join(out);
    expect(text).toContain('已折叠工具结果'); // 普通中间轮被折叠
    expect(text).toContain('最近一轮'); // 最近轮保留
  });
});
