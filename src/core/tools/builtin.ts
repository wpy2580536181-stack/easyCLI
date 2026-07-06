import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ToolContext, ToolDef, ToolResult } from '../chatmodel/types';

const execAsync = promisify(exec);

function ok(output: string): ToolResult {
  return { ok: true, output };
}
function fail(output: string): ToolResult {
  return { ok: false, output };
}

/** 读取文件：相对工作目录解析路径，返回文本内容 */
async function readFileTool(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const path = typeof args.path === 'string' ? args.path : '';
  if (!path) return fail('缺少参数 path');
  try {
    const content = await readFile(resolve(ctx.cwd, path), 'utf8');
    return ok(content);
  } catch (e) {
    return fail(`读取失败: ${(e as Error).message}`);
  }
}

/** 执行 shell 命令：返回 stdout/stderr 合并输出，错误时 ok:false */
async function bashTool(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const command = typeof args.command === 'string' ? args.command : '';
  if (!command) return fail('缺少参数 command');
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
 * 最小内置工具集（Phase 2 仅两个，证明 ReAct 循环非空转）。
 * 路径围栏 / 命令黑名单 / HITL 在 Phase 3 补全。
 */
export function getBuiltinTools(): ToolDef[] {
  return [
    {
      name: 'read_file',
      description: '读取指定路径的文本内容（相对工作目录）。用于查看文件内容。',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: '文件路径' } },
        required: ['path'],
      },
      isReadOnly: true,
      isDestructive: false,
      execute: readFileTool,
    },
    {
      name: 'bash',
      description: '在终端执行一条 shell 命令并返回标准输出/错误。',
      inputSchema: {
        type: 'object',
        properties: { command: { type: 'string', description: '要执行的 shell 命令' } },
        required: ['command'],
      },
      isReadOnly: false,
      isDestructive: false,
      execute: bashTool,
    },
  ];
}
