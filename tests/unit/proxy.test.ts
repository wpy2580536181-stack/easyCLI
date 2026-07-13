import { describe, it, expect } from 'vitest';
import { shouldBypassProxy, dispatcherForUrl } from '../../src/core/http/proxy';

describe('shouldBypassProxy / dispatcherForUrl（共享代理辅助）', () => {
  it('localhost / 私网目标应绕过代理', () => {
    expect(shouldBypassProxy('http://localhost:3000/x')).toBe(true);
    expect(shouldBypassProxy('http://127.0.0.1:8080')).toBe(true);
    expect(shouldBypassProxy('http://10.0.0.5')).toBe(true);
    expect(shouldBypassProxy('http://192.168.1.1')).toBe(true);
    expect(shouldBypassProxy('http://172.16.0.1')).toBe(true);
  });

  it('公网目标不绕过', () => {
    expect(shouldBypassProxy('https://api.deepseek.com/v1')).toBe(false);
  });

  it('解析非法 URL 不抛（返回 false）', () => {
    expect(shouldBypassProxy('not a url')).toBe(false);
  });

  it('localhost 目标 dispatcher 恒为 undefined（即使配了代理也走直连）', () => {
    expect(dispatcherForUrl('http://localhost:3000')).toBeUndefined();
  });
});
