import { afterEach, afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadConfig,
  loadUserConfig,
  saveUserConfig,
  maskSecret,
  appConfigToUserConfig,
} from '../../src/config';

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

describe('Phase 8 配置持久化（store + 文件层）', () => {
  let dir: string;
  let cfgPath: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'easycli-cfg-'));
    cfgPath = join(dir, 'config.json');
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('loadUserConfig 读取合法文件返回解析后的配置', async () => {
    await writeFile(
      cfgPath,
      JSON.stringify({
        provider: 'openai',
        model: 'deepseek-chat',
        apiKey: 'sk-abc',
        mcpServers: [{ command: 'node', args: ['s.mjs'] }],
        ragPaths: ['./docs'],
      }),
      'utf8',
    );
    const cfg = loadUserConfig(cfgPath);
    expect(cfg?.provider).toBe('openai');
    expect(cfg?.model).toBe('deepseek-chat');
    expect(cfg?.mcpServers?.[0]?.command).toBe('node');
    expect(cfg?.ragPaths).toEqual(['./docs']);
  });

  it('loadUserConfig 文件缺失返回 null', () => {
    expect(loadUserConfig(join(dir, 'nope.json'))).toBeNull();
  });

  it('loadUserConfig JSON 非法或 schema 不匹配返回 null', async () => {
    await writeFile(cfgPath, 'not json{', 'utf8');
    expect(loadUserConfig(cfgPath)).toBeNull();
    await writeFile(cfgPath, JSON.stringify({ mcpServers: 'wrong' }), 'utf8');
    expect(loadUserConfig(cfgPath)).toBeNull();
  });

  it('loadConfig 文件层：file > default', () => {
    vi.stubEnv('AGENTCLI_MODEL', '');
    vi.stubEnv('AGENTCLI_BASE_URL', '');
    vi.stubEnv('AGENTCLI_API_KEY', '');
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('AGENTCLI_PROVIDER', '');
    const config = loadConfig({}, { model: 'from-file', provider: 'anthropic' });
    expect(config.llm.model).toBe('from-file');
    expect(config.provider).toBe('anthropic');
  });

  it('loadConfig 文件层：env > file', () => {
    vi.stubEnv('AGENTCLI_MODEL', 'from-env');
    vi.stubEnv('AGENTCLI_BASE_URL', '');
    vi.stubEnv('AGENTCLI_API_KEY', '');
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('AGENTCLI_PROVIDER', '');
    const config = loadConfig({}, { model: 'from-file' });
    expect(config.llm.model).toBe('from-env');
  });

  it('loadConfig 文件层：CLI > env > file', () => {
    vi.stubEnv('AGENTCLI_MODEL', 'from-env');
    vi.stubEnv('AGENTCLI_BASE_URL', '');
    vi.stubEnv('AGENTCLI_API_KEY', '');
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('AGENTCLI_PROVIDER', '');
    const config = loadConfig({ model: 'from-cli' }, { model: 'from-file' });
    expect(config.llm.model).toBe('from-cli');
  });

  it('loadConfig 文件层：mcpServers / ragPath 同样 CLI > env > file', () => {
    vi.stubEnv('AGENTCLI_RAG_PATH', 'env1,env2');
    vi.stubEnv('AGENTCLI_MCP_SERVERS', JSON.stringify([{ command: 'env-cmd' }]));
    vi.stubEnv('AGENTCLI_MODEL', '');
    vi.stubEnv('AGENTCLI_BASE_URL', '');
    vi.stubEnv('AGENTCLI_API_KEY', '');
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('AGENTCLI_PROVIDER', '');
    const config = loadConfig({ rag: 'cli1' }, { ragPaths: ['file1'], mcpServers: [{ command: 'file-cmd' }] });
    expect(config.ragPath).toBe('cli1'); // CLI 覆盖
    expect(config.mcpServers[0]?.command).toBe('env-cmd'); // CLI 未给 mcp → env 优先于 file
  });

  it('saveUserConfig 写盘且与已有文件浅合并', async () => {
    const p = join(dir, 'save.json');
    await writeFile(p, JSON.stringify({ provider: 'openai', model: 'a' }), 'utf8');
    saveUserConfig({ model: 'b', apiKey: 'sk-x' }, p);
    const after = loadUserConfig(p);
    expect(after?.provider).toBe('openai'); // 保留未覆盖字段
    expect(after?.model).toBe('b'); // 覆盖
    expect(after?.apiKey).toBe('sk-x'); // 新增
  });

  it('appConfigToUserConfig 仅提取非空字段', () => {
    const uc = appConfigToUserConfig({
      provider: 'openai',
      llm: { baseURL: 'https://x', apiKey: 'sk-y', model: 'm' },
      mcpServers: [{ command: 'c' }],
      ragPath: './d',
      embedder: { type: 'tfidf' },
      search: { provider: 'duckduckgo' },
      statusline: true,
    });
    expect(uc).toEqual({
      provider: 'openai',
      baseURL: 'https://x',
      apiKey: 'sk-y',
      model: 'm',
      mcpServers: [{ command: 'c' }],
      ragPaths: ['./d'],
    });
  });

  it('maskSecret 对密钥打码，空串给占位', () => {
    expect(maskSecret('')).toBe('(空)');
    expect(maskSecret('sk-123')).toBe('****');
    expect(maskSecret('sk-abcdefghij')).toBe('sk-a****ghij');
  });
});
