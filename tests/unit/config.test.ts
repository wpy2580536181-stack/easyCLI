import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config';

describe('loadConfig 配置合并', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('使用默认值（无 env、无覆盖）', () => {
    vi.stubEnv('AGENTCLI_PROVIDER', '');
    vi.stubEnv('AGENTCLI_BASE_URL', '');
    vi.stubEnv('AGENTCLI_API_KEY', '');
    vi.stubEnv('AGENTCLI_MODEL', '');
    vi.stubEnv('OPENAI_API_KEY', '');

    const config = loadConfig();
    expect(config.provider).toBe('openai');
    expect(config.llm.baseURL).toBe('https://api.deepseek.com/v1');
    expect(config.llm.model).toBe('deepseek-chat');
    expect(config.llm.apiKey).toBe('');
  });

  it('环境变量覆盖默认值', () => {
    vi.stubEnv('AGENTCLI_API_KEY', 'env-key');
    vi.stubEnv('AGENTCLI_MODEL', 'glm-4');
    vi.stubEnv('AGENTCLI_BASE_URL', 'https://open.bigmodel.cn/api/paas/v4');

    const config = loadConfig();
    expect(config.llm.apiKey).toBe('env-key');
    expect(config.llm.model).toBe('glm-4');
    expect(config.llm.baseURL).toBe('https://open.bigmodel.cn/api/paas/v4');
  });

  it('CLI 覆盖参数优先级最高', () => {
    vi.stubEnv('AGENTCLI_API_KEY', 'env-key');
    vi.stubEnv('AGENTCLI_MODEL', 'glm-4');

    const config = loadConfig({ apiKey: 'cli-key', model: 'deepseek-v3' });
    expect(config.llm.apiKey).toBe('cli-key');
    expect(config.llm.model).toBe('deepseek-v3');
  });

  it('OPENAI_API_KEY 作为 apiKey 兜底', () => {
    vi.stubEnv('AGENTCLI_API_KEY', '');
    vi.stubEnv('OPENAI_API_KEY', 'fallback-key');

    const config = loadConfig();
    expect(config.llm.apiKey).toBe('fallback-key');
  });
});
