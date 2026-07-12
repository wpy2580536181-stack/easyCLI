import { describe, it, expect } from 'vitest';
import { writeFile, mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolRegistry, createToolRegistry } from '../../src/core/tools/registry';
import { getBuiltinTools } from '../../src/core/tools/builtin';

describe('ToolRegistry', () => {
  it('register / get / list / has', () => {
    const r = new ToolRegistry();
    r.registerAll(getBuiltinTools());
    expect(r.list().map((t) => t.name)).toContain('read_file');
    expect(r.has('bash')).toBe(true);
    expect(r.get('read_file')?.isReadOnly).toBe(true);
  });

  it('createToolRegistry 默认注册内置工具', () => {
    const r = createToolRegistry();
    expect(r.list().length).toBeGreaterThanOrEqual(2);
  });

  it('重复注册同名工具会被覆盖', async () => {
    const r = new ToolRegistry();
    r.register({ name: 'x', description: '', inputSchema: {}, execute: async () => ({ ok: true, output: '1' }) });
    r.register({ name: 'x', description: '', inputSchema: {}, execute: async () => ({ ok: true, output: '2' }) });
    const res = await r.get('x')!.execute!({}, { cwd: '.' });
    expect(res.output).toBe('2');
  });
});

describe('内置工具执行', () => {
  it('read_file 读取文件内容', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'easycli-'));
    const file = join(dir, 'a.txt');
    await writeFile(file, 'hello-world', 'utf8');
    const tool = getBuiltinTools().find((t) => t.name === 'read_file')!;
    const res = await tool.execute!({ path: 'a.txt' }, { cwd: dir });
    expect(res.ok).toBe(true);
    expect(res.output).toBe('hello-world');
    await rm(dir, { recursive: true, force: true });
  });

  it('read_file 文件不存在返回 ok:false', async () => {
    const tool = getBuiltinTools().find((t) => t.name === 'read_file')!;
    const res = await tool.execute!({ path: 'nope.txt' }, { cwd: process.cwd() });
    expect(res.ok).toBe(false);
  });

  it('bash 执行命令并返回输出', async () => {
    const tool = getBuiltinTools().find((t) => t.name === 'bash')!;
    const res = await tool.execute!({ command: 'echo cli-test' }, { cwd: process.cwd() });
    expect(res.ok).toBe(true);
    expect(res.output).toBe('cli-test');
  });

  it('bash 命令失败时 ok:false 且带错误信息', async () => {
    const tool = getBuiltinTools().find((t) => t.name === 'bash')!;
    const res = await tool.execute!({ command: 'exit 3' }, { cwd: process.cwd() });
    expect(res.ok).toBe(false);
  });
});

describe('grep 工具（ripgrep 后端）', () => {
  it('匹配行返回 文件:行号:内容 格式', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'easycli-grep-'));
    await writeFile(join(dir, 'app.ts'), 'const a = 1;\nconst needle = 2;\nconst b = 3;\n', 'utf8');
    const tool = getBuiltinTools().find((t) => t.name === 'grep')!;
    const res = await tool.execute!({ pattern: 'needle', path: '.' }, { cwd: dir });
    expect(res.ok).toBe(true);
    expect(res.output).toContain('app.ts:2:const needle = 2');
    await rm(dir, { recursive: true, force: true });
  });

  it('无匹配返回 (无匹配)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'easycli-grep-'));
    await writeFile(join(dir, 'app.ts'), 'const a = 1;\n', 'utf8');
    const tool = getBuiltinTools().find((t) => t.name === 'grep')!;
    const res = await tool.execute!({ pattern: 'zzz_not_exist' }, { cwd: dir });
    expect(res.ok).toBe(true);
    expect(res.output).toBe('(无匹配)');
    await rm(dir, { recursive: true, force: true });
  });

  it('自动跳过 node_modules（.gitignore 感知）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'easycli-grep-'));
    await writeFile(join(dir, '.gitignore'), 'node_modules/\n', 'utf8');
    await writeFile(join(dir, 'app.ts'), 'const needle = 1;\n', 'utf8');
    await mkdir(join(dir, 'node_modules', 'lib'), { recursive: true });
    await writeFile(join(dir, 'node_modules', 'lib', 'index.js'), 'const needle = 2;\n', 'utf8');
    const tool = getBuiltinTools().find((t) => t.name === 'grep')!;
    const res = await tool.execute!({ pattern: 'needle', path: '.' }, { cwd: dir });
    expect(res.ok).toBe(true);
    expect(res.output).toContain('app.ts:1:const needle = 1');
    expect(res.output).not.toContain('node_modules');
    await rm(dir, { recursive: true, force: true });
  });

  it('匹配结果截断到 200 行', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'easycli-grep-'));
    const content = Array.from({ length: 250 }, (_, i) => `line${i}: needle here`).join('\n') + '\n';
    await writeFile(join(dir, 'big.ts'), content, 'utf8');
    const tool = getBuiltinTools().find((t) => t.name === 'grep')!;
    const res = await tool.execute!({ pattern: 'needle', path: '.' }, { cwd: dir });
    expect(res.ok).toBe(true);
    expect(res.output.split('\n').length).toBe(200);
    await rm(dir, { recursive: true, force: true });
  });
});
