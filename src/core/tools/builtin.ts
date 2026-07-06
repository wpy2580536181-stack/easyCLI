import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import type { ToolContext, ToolDef, ToolResult } from '../chatmodel/types';
import { resolveSafe } from '../security/path-fence';
import { checkCommand } from '../security/command-blacklist';

const execAsync = promisify(exec);

function ok(output: string): ToolResult {
  return { ok: true, output };
}
function fail(output: string): ToolResult {
  return { ok: false, output };
}

async function* walk(dir: string, depth = 0): AsyncGenerator<string> {
  if (depth > 12) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) yield* walk(full, depth + 1);
    else if (e.isFile()) yield full;
  }
}

function patternToRegExp(pat: string): RegExp {
  const esc = pat
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '§')
    .replace(/\*/g, '[^/]*')
    .replace(/§/g, '.*');
  return new RegExp('^' + esc + '$');
}

// ── read_file ──────────────────────────────────────────────
async function readFileTool(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const path = typeof args.path === 'string' ? args.path : '';
  if (!path) return fail('缺少参数 path');
  try {
    const content = await readFile(resolveSafe(ctx.cwd, path), 'utf8');
    return ok(content);
  } catch (e) {
    return fail(`读取失败: ${(e as Error).message}`);
  }
}

// ── write_file ─────────────────────────────────────────────
async function writeFileTool(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const path = typeof args.path === 'string' ? args.path : '';
  const content = typeof args.content === 'string' ? args.content : '';
  if (!path) return fail('缺少参数 path');
  try {
    const abs = resolveSafe(ctx.cwd, path);
    await writeFile(abs, content, 'utf8');
    return ok(`已写入 ${path}（${content.length} 字符）`);
  } catch (e) {
    return fail(`写入失败: ${(e as Error).message}`);
  }
}

// ── edit_file（替换首处匹配） ──────────────────────────────
async function editFileTool(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const path = typeof args.path === 'string' ? args.path : '';
  const oldStr = typeof args.old === 'string' ? args.old : '';
  const newStr = typeof args.new === 'string' ? args.new : '';
  if (!path || !oldStr) return fail('缺少参数 path / old');
  try {
    const abs = resolveSafe(ctx.cwd, path);
    const text = await readFile(abs, 'utf8');
    if (!text.includes(oldStr)) return fail('未找到待替换内容');
    await writeFile(abs, text.replace(oldStr, newStr), 'utf8');
    return ok(`已编辑 ${path}`);
  } catch (e) {
    return fail(`编辑失败: ${(e as Error).message}`);
  }
}

// ── list_dir ──────────────────────────────────────────────
async function listDirTool(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const path = typeof args.path === 'string' && args.path ? args.path : '.';
  try {
    const abs = resolveSafe(ctx.cwd, path);
    const entries = await readdir(abs, { withFileTypes: true });
    const lines = entries.map((e) => (e.isDirectory() ? `[d] ${e.name}` : `[f] ${e.name}`));
    return ok(lines.join('\n'));
  } catch (e) {
    return fail(`列目录失败: ${(e as Error).message}`);
  }
}

// ── glob ──────────────────────────────────────────────────
async function globTool(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const pattern = typeof args.pattern === 'string' ? args.pattern : '*';
  try {
    const re = patternToRegExp(pattern);
    const out: string[] = [];
    for await (const f of walk(resolveSafe(ctx.cwd, '.'))) {
      const rel = relative(ctx.cwd, f).split(sep).join('/');
      if (re.test(rel)) out.push(rel);
    }
    return ok(out.sort().join('\n') || '(无匹配)');
  } catch (e) {
    return fail(`glob 失败: ${(e as Error).message}`);
  }
}

// ── grep ──────────────────────────────────────────────────
async function grepTool(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const pattern = typeof args.pattern === 'string' ? args.pattern : '';
  const path = typeof args.path === 'string' && args.path ? args.path : '.';
  if (!pattern) return fail('缺少参数 pattern');
  try {
    const re = new RegExp(pattern);
    const out: string[] = [];
    for await (const f of walk(resolveSafe(ctx.cwd, path))) {
      let text: string;
      try {
        text = await readFile(f, 'utf8');
      } catch {
        continue;
      }
      if (text.length > 1_000_000) continue;
      const rel = relative(ctx.cwd, f);
      text.split('\n').forEach((line, i) => {
        if (re.test(line)) out.push(`${rel}:${i + 1}:${line}`);
      });
    }
    return ok(out.slice(0, 200).join('\n') || '(无匹配)');
  } catch (e) {
    return fail(`grep 失败: ${(e as Error).message}`);
  }
}

// ── bash（命令黑名单硬 gate） ─────────────────────────────
async function bashTool(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const command = typeof args.command === 'string' ? args.command : '';
  if (!command) return fail('缺少参数 command');
  const blocked = checkCommand(command);
  if (!blocked.ok) return fail(`命令被拒绝: ${blocked.reason}`);
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: ctx.cwd,
      signal: ctx.signal,
      maxBuffer: 1024 * 1024,
    });
    return ok((stdout + stderr).trim());
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    const out = (err.stdout ?? '') + (err.stderr ?? '');
    return fail(out.trim() || err.message || '命令执行失败');
  }
}

/**
 * 内置工具集（Phase 3 扩展）：文件读写编辑、列目录、glob、grep、bash。
 * 文件类工具统一走路径围栏；bash 走命令黑名单——均为不可关闭的硬 gate。
 * read-only 工具标记 isReadOnly，供执行器「只读并行」优化。
 */
export function getBuiltinTools(): ToolDef[] {
  return [
    {
      name: 'read_file',
      description: '读取指定路径的文本内容（相对工作目录，受限在项目根内）。',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      isReadOnly: true,
      isDestructive: false,
      execute: readFileTool,
    },
    {
      name: 'write_file',
      description: '把内容写入指定路径（覆盖写）。',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
      },
      isReadOnly: false,
      isDestructive: false,
      execute: writeFileTool,
    },
    {
      name: 'edit_file',
      description: '把文件中的 old 文本替换为 new（替换首处匹配）。',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' }, old: { type: 'string' }, new: { type: 'string' } },
        required: ['path', 'old', 'new'],
      },
      isReadOnly: false,
      isDestructive: false,
      execute: editFileTool,
    },
    {
      name: 'list_dir',
      description: '列出目录内容（d=目录，f=文件）。',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
      isReadOnly: true,
      isDestructive: false,
      execute: listDirTool,
    },
    {
      name: 'glob',
      description: '按通配符匹配文件路径（支持 * 与 **）。',
      inputSchema: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] },
      isReadOnly: true,
      isDestructive: false,
      execute: globTool,
    },
    {
      name: 'grep',
      description: '在工作区内递归搜索匹配正则的行，返回 文件:行号:内容。',
      inputSchema: {
        type: 'object',
        properties: { pattern: { type: 'string' }, path: { type: 'string' } },
        required: ['pattern'],
      },
      isReadOnly: true,
      isDestructive: false,
      execute: grepTool,
    },
    {
      name: 'bash',
      description: '执行一条 shell 命令（破坏性命令会被黑名单拦截）。',
      inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
      isReadOnly: false,
      isDestructive: false,
      execute: bashTool,
    },
  ];
}
