import { describe, it, expect } from 'vitest';
import {
  compressHistory,
  estimateTokens,
  estimateHistoryTokens,
  messageText,
  type CompressOptions,
} from '../../src/core/memory/compressor';
import type { ChatMessage, ContentBlock } from '../../src/core/chatmodel/types';

function tool(content: string, id = 't1'): ChatMessage {
  return { role: 'tool', tool_call_id: id, content };
}
function assistantWithTool(id: string, name: string): ChatMessage {
  const blocks: ContentBlock[] = [
    { type: 'tool_call', id, name, arguments: { path: 'x' } },
  ];
  return { role: 'assistant', content: blocks };
}
function user(text: string): ChatMessage {
  return { role: 'user', content: text };
}
function system(text: string): ChatMessage {
  return { role: 'system', content: text };
}

/** 校验 tool_call ↔ tool_result 配对在压缩后仍合法 */
function validatePairing(h: ChatMessage[]): boolean {
  for (let i = 0; i < h.length; i++) {
    const m = h[i]!;
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b.type === 'tool_call') {
          if (!h.slice(i + 1).some((x) => x.role === 'tool' && x.tool_call_id === b.id)) return false;
        }
      }
    }
    if (m.role === 'tool' && m.tool_call_id) {
      const ok = h.slice(0, i).some(
        (x) =>
          x.role === 'assistant' &&
          Array.isArray(x.content) &&
          x.content.some((b) => b.type === 'tool_call' && b.id === m.tool_call_id),
      );
      if (!ok) return false;
    }
  }
  return true;
}

describe('estimateTokens / messageText', () => {
  it('粗略估算 ~4 字符/token', () => {
    expect(estimateTokens('hello world')).toBe(3); // 11 → ceil(2.75)=3
    expect(estimateTokens('')).toBe(1); // 最小为 1
  });
  it('ContentBlock[] 拼成文本', () => {
    expect(messageText({ role: 'assistant', content: [{ type: 'text', text: 'ab' }] })).toBe('ab');
  });
});

describe('第 1 级：裁剪超长工具输出', () => {
  it('工具结果超过上限被裁剪并打标记', async () => {
    const history = [user('u'), tool('x'.repeat(5000))];
    const opts: CompressOptions = { budgetTokens: 100, keepRecentTurns: 4, maxToolOutputChars: 50 };
    const out = await compressHistory(history, opts);
    const t = out.find((m) => m.role === 'tool')!;
    expect(messageText(t).length).toBeLessThanOrEqual(50 + 20);
    expect(messageText(t)).toContain('[已裁剪');
    expect(t.tool_call_id).toBe('t1');
  });
});

describe('第 2 级：去重相邻相同工具结果', () => {
  it('连续相同工具结果只保留一个', async () => {
    const history = [user('u'), tool('X'), tool('X')];
    const opts: CompressOptions = { budgetTokens: 2, keepRecentTurns: 4, maxToolOutputChars: 9999 };
    const out = await compressHistory(history, opts);
    const tools = out.filter((m) => m.role === 'tool');
    expect(tools).toHaveLength(1);
    expect(messageText(tools[0]!)).toBe('X');
  });
});

describe('第 3 级：折叠中间工具结果（保留配对）', () => {
  it('工具结果被折叠为占位，tool_call_id 不变，配对仍合法', async () => {
    const history = [
      user('u1'),
      assistantWithTool('a', 'read_file'),
      tool('y'.repeat(3000), 'a'),
      user('u2'),
    ];
    const opts: CompressOptions = { budgetTokens: 5, keepRecentTurns: 1, maxToolOutputChars: 9999 };
    const out = await compressHistory(history, opts);
    const folded = out.find((m) => m.role === 'tool' && m.tool_call_id === 'a')!;
    expect(messageText(folded)).toContain('[已折叠工具结果');
    expect(validatePairing(out)).toBe(true);
  });
});

describe('第 4 级：摘要（模型把中间轮压缩成一条）', () => {
  it('中间轮被摘要成 system 消息，最近轮保留，system 原样保留', async () => {
    const history = [
      system('SYS'),
      user('u1'),
      assistantWithTool('a', 'read_file'),
      tool('old result content', 'a'),
      user('u2'),
      assistantWithTool('b', 'read_file'),
      tool('recent result content', 'b'),
    ];
    const opts: CompressOptions = {
      budgetTokens: 5,
      keepRecentTurns: 1,
      maxToolOutputChars: 9999,
      summarizer: async () => 'SUMMARY',
    };
    const out = await compressHistory(history, opts);
    expect(out[0]).toEqual(system('SYS')); // 原 system 在最前
    expect(messageText(out[1]!)).toContain('[历史摘要]');
    expect(messageText(out[1]!)).toContain('SUMMARY');
    // 最近一轮（u2 + assistant b + tool b）完整保留
    expect(out.some((m) => m.role === 'tool' && m.tool_call_id === 'b')).toBe(true);
    // 中间轮 a 已被摘要替换，不应再有 tool_call_id a 的工具消息
    expect(out.some((m) => m.role === 'tool' && m.tool_call_id === 'a')).toBe(false);
    expect(validatePairing(out)).toBe(true);
  });

  it('摘要器失败则回退到折叠，不抛错', async () => {
    const history = [
      user('u1'),
      assistantWithTool('a', 'read_file'),
      tool('z'.repeat(3000), 'a'),
      user('u2'),
    ];
    const opts: CompressOptions = {
      budgetTokens: 5,
      keepRecentTurns: 1,
      maxToolOutputChars: 9999,
      summarizer: async () => {
        throw new Error('boom');
      },
    };
    const out = await compressHistory(history, opts);
    expect(validatePairing(out)).toBe(true);
    // 摘要失败回退折叠：原始超长内容不应再出现在结果中
    expect(out.some((m) => m.role === 'tool' && messageText(m).includes('z'.repeat(3000)))).toBe(false);
  });
});

describe('压缩不破坏整体配对', () => {
  it('多轮工具调用压缩后配对仍全部合法', async () => {
    const history: ChatMessage[] = [system('SYS')];
    for (let i = 0; i < 6; i++) {
      history.push(user(`u${i}`));
      history.push(assistantWithTool(`c${i}`, 'read_file'));
      history.push(tool(`result ${i} `.repeat(200), `c${i}`));
    }
    const opts: CompressOptions = {
      budgetTokens: 200,
      keepRecentTurns: 2,
      maxToolOutputChars: 200,
      summarizer: async (t) => 'SUMMARY:' + t.length,
    };
    const out = await compressHistory(history, opts);
    expect(validatePairing(out)).toBe(true);
    expect(out[0]).toEqual(system('SYS'));
    const before = estimateHistoryTokens(history);
    const after = estimateHistoryTokens(out);
    expect(after).toBeLessThan(before); // 确实压缩了
    expect(after).toBeLessThanOrEqual(200); // 预算内（最近 2 轮受保护，预算需 ≥ 其体积）
  });
});
