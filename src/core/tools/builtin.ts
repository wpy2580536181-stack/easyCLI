import { readFile, writeFile, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, relative } from 'node:path';
import type { ToolContext, ToolDef, ToolResult } from '../chatmodel/types';
import { resolveSafe } from '../security/path-fence';
import { checkCommand } from '../security/command-blacklist';
import { createSandbox } from '../security/sandbox';
import fg from 'fast-glob';

const sandbox = createSandbox();

function ok(output: string): ToolResult {
  return { ok: true, output };
}
function fail(output: string): ToolResult {
  return { ok: false, output };
}

// 文件枚举统一交给 fast-glob：支持 ** / * / ? / [abc] / {a,b} 等完整语法，
// 走高效目录遍历，不再像旧版那样全量递归后再用正则过滤（大仓库下快几个数量级）。

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
  const pattern = typeof args.pattern === 'string' && args.pattern ? args.pattern : '*';
  try {
    // 交给 fast-glob：完整支持 ** / * / ? / [abc] / {a,b} 语法，且只遍历匹配路径，
    // 不再像旧版那样全量递归后再用正则过滤（大仓库下快几个数量级）。
    const absRoot = resolveSafe(ctx.cwd, '.');
    const out = fg.sync(pattern, { cwd: absRoot, dot: true, onlyFiles: true }).sort();
    return ok(out.join('\n') || '(无匹配)');
  } catch (e) {
    return fail(`glob 失败: ${(e as Error).message}`);
  }
}

// ripgrep 是否可用（首次探测后缓存，避免每次查询都 fork 一次）
let rgAvailable: boolean | null = null;
function hasRipgrep(): boolean {
  if (rgAvailable === null) {
    try {
      const r = spawnSync('rg', ['--version'], { encoding: 'utf8' });
      rgAvailable = !r.error && (r.stdout || '').includes('ripgrep');
    } catch {
      rgAvailable = false;
    }
  }
  return rgAvailable;
}

// 进程内 JS 扫描兜底（环境无 rg 时保持工具可用，行为与原实现一致）
async function grepJS(pattern: string, path: string, ctx: ToolContext): Promise<string> {
  const re = new RegExp(pattern);
  const absRoot = resolveSafe(ctx.cwd, path);
  // 用 fast-glob 枚举全部文件（等价于旧版递归 walk），再在进程内做正则扫描
  const files = fg.sync('**', { cwd: absRoot, dot: true, onlyFiles: true });
  const out: string[] = [];
  for (const relFromRoot of files) {
    const f = join(absRoot, relFromRoot);
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
  return out.slice(0, 200).join('\n') || '(无匹配)';
}

// ── grep ──────────────────────────────────────────────────
// 优先用 ripgrep：gitignore 感知、并行扫描、自动跳过二进制/超大文件，
// 大仓库（尤其含 node_modules）下远快于纯 JS 扫描。环境无 rg 时回退 JS。
// rg 默认退出码：0=有匹配，1=无匹配，2=报错（多为正则语法问题）。
async function grepTool(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const pattern = typeof args.pattern === 'string' ? args.pattern : '';
  const path = typeof args.path === 'string' && args.path ? args.path : '.';
  if (!pattern) return fail('缺少参数 pattern');
  if (hasRipgrep()) {
    try {
      const absRoot = resolveSafe(ctx.cwd, path);
      const relRoot = relative(ctx.cwd, absRoot) || '.';
      const r = spawnSync(
        'rg',
        ['-n', '-H', '--no-heading', '--no-require-git', '--max-filesize', '1M', '-e', pattern, relRoot],
        { cwd: ctx.cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
      );
      if (r.error) return ok(await grepJS(pattern, path, ctx)); // 中途不可用，回退
      if (r.status === 0) {
        const lines = (r.stdout || '').split('\n');
        lines.pop(); // 去掉末尾空行
        // rg 搜索根为 '.' 时路径带 ./ 前缀，剥掉以保持与原 JS 实现格式一致
        const cleaned = lines.map((l) => l.replace(/^\.\//, ''));
        return ok(cleaned.slice(0, 200).join('\n') || '(无匹配)');
      }
      if (r.status === 1) return ok('(无匹配)');
      return fail(`grep 失败: ${(r.stderr || '').trim().split('\n')[0] || '未知错误'}`);
    } catch {
      return ok(await grepJS(pattern, path, ctx)); // 输出超限等异常，回退
    }
  }
  return ok(await grepJS(pattern, path, ctx));
}

// ── bash（命令黑名单硬 gate → 权限/HITL → 软 sandbox 资源限额） ──
async function bashTool(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const command = typeof args.command === 'string' ? args.command : '';
  if (!command) return fail('缺少参数 command');
  const blocked = checkCommand(command);
  if (!blocked.ok) return fail(`命令被拒绝: ${blocked.reason}`);
  try {
    // 经软 sandbox 运行：权限/HITL 通过后再加一层资源限额护栏
    // （fork 炸弹 / 无限循环 / 写出超大文件）。文件类工具已走路径围栏，豁免本沙箱。
    const res = await sandbox.run(command, {
      cwd: ctx.cwd,
      signal: ctx.signal,
      maxBuffer: 1024 * 1024,
    });
    if (res.code !== 0) return fail((res.stdout + res.stderr).trim());
    return ok((res.stdout + res.stderr).trim());
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
      description: '在工作区内递归搜索匹配正则的行，返回 文件:行号:内容。底层用 ripgrep：自动跳过 node_modules/被 gitignore 的文件与二进制，大仓库下远快于普通 grep。',
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
