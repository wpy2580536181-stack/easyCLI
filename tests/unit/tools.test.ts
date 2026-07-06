import { describe, it, expect } from 'vitest';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
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
