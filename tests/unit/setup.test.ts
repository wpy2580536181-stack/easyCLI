// 首次运行配置向导单元测试。
// 通过注入 MockPrompter + 临时落盘路径，覆盖：必填校验、默认值回退、落盘内容。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runFirstRunSetup, type SetupPrompter } from '../../src/cli/setup';
import { saveUserConfig, type UserConfig } from '../../src/config';

/** 可注入的提问器：按预设序列依次返回（secret/text 共用一个游标）。 */
class MockPrompter implements SetupPrompter {
  private responses: string[];
  private idx = 0;
  secretCalls = 0;

  constructor(responses: string[]) {
    this.responses = responses;
  }

  private next(): string {
    const v = this.responses[this.idx];
    this.idx += 1;
    return v ?? '';
  }

  async text(question: string, def?: string): Promise<string> {
    const v = this.next();
    return v || def || '';
  }

  async secret(question: string): Promise<string> {
    this.secretCalls += 1;
    return this.next();
  }
}

describe('首次运行配置向导 runFirstRunSetup', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'setup-'));
    path = join(dir, 'config.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('收集 apiKey/baseURL/model 并落盘到指定路径', async () => {
    const res = await runFirstRunSetup({
      prompter: new MockPrompter(['sk-abcd1234', 'https://api.example.com/v1', 'my-model']),
      save: (cfg: UserConfig) => saveUserConfig(cfg, path),
      out: { write() {} },
    });

    expect(res.config.apiKey).toBe('sk-abcd1234');
    expect(res.config.model).toBe('my-model');
    expect(res.config.baseURL).toBe('https://api.example.com/v1');
    expect(existsSync(path)).toBe(true);

    const written = JSON.parse(readFileSync(path, 'utf8'));
    expect(written.apiKey).toBe('sk-abcd1234');
    expect(written.model).toBe('my-model');
    expect(written.baseURL).toBe('https://api.example.com/v1');
  });

  it('API Key 为空时循环重问，直到非空才落盘', async () => {
    const prompter = new MockPrompter(['', '', 'sk-final-key']);
    let saved = false;

    await runFirstRunSetup({
      prompter,
      save: (cfg: UserConfig) => {
        saved = true;
        saveUserConfig(cfg, path);
      },
      out: { write() {} },
    });

    // 两次空串 + 一次有效 = 3 次 secret 调用
    expect(prompter.secretCalls).toBe(3);
    expect(saved).toBe(true);
    const written = JSON.parse(readFileSync(path, 'utf8'));
    expect(written.apiKey).toBe('sk-final-key');
  });

  it('baseURL/model 回车（空响应）时回退默认值', async () => {
    const otherDir = mkdtempSync(join(tmpdir(), 'setup-def-'));
    const otherPath = join(otherDir, 'config.json');

    await runFirstRunSetup({
      prompter: new MockPrompter(['sk-xyz', '', '']),
      save: (cfg: UserConfig) => saveUserConfig(cfg, otherPath),
      out: { write() {} },
    });

    const written = JSON.parse(readFileSync(otherPath, 'utf8'));
    expect(written.baseURL).toBe('https://api.deepseek.com/v1');
    expect(written.model).toBe('deepseek-chat');

    rmSync(otherDir, { recursive: true, force: true });
  });
});
