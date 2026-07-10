import { describe, it, expect } from 'vitest';
import {
  CalibratedCounter,
  createDefaultCounter,
  createCounter,
  estimateTokens,
} from '../../src/core/observability/tokenizer';

describe('TokenCounter', () => {
  it('CalibratedCounter 返回正整数', () => {
    const c = new CalibratedCounter();
    const n = c.count('hello world');
    expect(Number.isInteger(n)).toBe(true);
    expect(n).toBeGreaterThan(0);
  });

  it('CJK 文本按 ~1 token/字 计，且不低估（vs 朴素 /4）', () => {
    const c = new CalibratedCounter();
    const cn = '你好世界这是中文测试内容'; // 12 个宽字符
    const naive = Math.floor(cn.length / 4); // 朴素 /4 = 3（严重低估）
    // CJK 感知计数应显著高于朴素 /4，且不低估中文
    expect(c.count(cn)).toBeGreaterThan(naive);
    expect(c.count(cn)).toBeGreaterThanOrEqual(10); // ≈ 12 token
  });

  it('calibrate 收敛到真实比例', () => {
    const c = new CalibratedCounter();
    // 真实比估算高 1.5 倍，喂 30 次让指数移动平均收敛
    for (let i = 0; i < 30; i++) c.calibrate(150, 100);
    const est = estimateTokens('some sample text');
    const got = c.count('some sample text');
    // 校准后 count ≈ est * 1.5，误差 < 15%
    expect(Math.abs(got - est * 1.5)).toBeLessThan(Math.max(2, est * 0.15));
  });

  it('createDefaultCounter 返回可复用单例', () => {
    expect(createDefaultCounter()).toBe(createDefaultCounter());
  });

  it('createCounter("auto") 零依赖回退到自校准', async () => {
    const c = await createCounter('auto');
    expect(c.count('hi there')).toBeGreaterThan(0);
  });

  it('createCounter("tiktoken") 未安装时静默回退（不抛）', async () => {
    const c = await createCounter('tiktoken');
    expect(c.count('fallback works')).toBeGreaterThan(0);
  });
});
