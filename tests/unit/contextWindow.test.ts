import { describe, it, expect } from 'vitest';
import { defaultContextWindow, resolveCompressBudget } from '../../src/core/chatmodel/contextWindow';

describe('defaultContextWindow', () => {
  it('已知模型精确覆盖优先（如 deepseek-chat 64K）', () => {
    expect(defaultContextWindow('openai', 'deepseek-chat')).toBe(64_000);
  });
  it('未命中模型时用 provider 默认', () => {
    expect(defaultContextWindow('anthropic', 'claude-3-foo')).toBe(200_000);
    expect(defaultContextWindow('ollama', 'llama3')).toBe(32_000);
  });
  it('未知 provider 回退 128K', () => {
    expect(defaultContextWindow('unknown', 'x')).toBe(128_000);
  });
});

describe('resolveCompressBudget（窗口相对预算）', () => {
  it('200K 窗口 → 约 174K，不再过早压缩', () => {
    // 200000 - 16384 - 20000 = 163616
    expect(resolveCompressBudget(200_000)).toBe(163_616);
  });
  it('小窗口（32K）取 8000 硬下限', () => {
    // 32000 - 16384 - 20000 = -4384 → max(8000, ...) = 8000
    expect(resolveCompressBudget(32_000)).toBe(8000);
  });
  it('64K 窗口 → 约 28K', () => {
    expect(resolveCompressBudget(64_000)).toBe(27_616);
  });
});
