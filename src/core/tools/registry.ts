import type { ToolDef } from '../chatmodel/types';
import { getBuiltinTools } from './builtin';

/**
 * 工具注册表：内置工具与 MCP 工具统一进同一张表，按 name 检索。
 * Agent 循环只认 ToolRegistry，不关心工具来自本地实现还是 MCP Server。
 */
export class ToolRegistry {
  private readonly tools = new Map<string, ToolDef>();

  register(tool: ToolDef): void {
    this.tools.set(tool.name, tool);
  }

  registerAll(tools: ToolDef[]): void {
    for (const t of tools) this.register(t);
  }

  get(name: string): ToolDef | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): ToolDef[] {
    return [...this.tools.values()];
  }
}

/** 组合根：构造一个已注册好内置工具的注册表 */
export function createToolRegistry(): ToolRegistry {
  const r = new ToolRegistry();
  r.registerAll(getBuiltinTools());
  return r;
}
