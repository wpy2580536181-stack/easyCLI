import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { ToolRegistry } from '../tools/registry';

export type Decision = 'allow' | 'deny' | 'ask';

export interface PermissionSettings {
  /** 已批准的工具名或 `tool:detail`（如 `bash:ls -la`） */
  allow: string[];
  /** 明确拒绝的工具名或 `tool:detail` */
  deny: string[];
}

export type Resolver = (tool: string, detail: string) => Decision | Promise<Decision>;

export interface PermissionOptions {
  /** 持久化路径，默认 ~/.config/agent-cli/settings.json */
  settingsPath?: string;
  /** 用于分类 read-only / destructive（决定默认策略） */
  registry?: ToolRegistry;
  /** HITL 提示器（交互式 REPL 注入）；不提供时 ask 走 defaultForAsk */
  resolver?: Resolver;
  /** 无 resolver 时 ask 的默认决定，默认 'deny' */
  defaultForAsk?: Decision;
}

/**
 * 三级权限（allow / deny / ask）+ 持久化。
 * 决策顺序：deny 列表 → allow 列表 → 默认策略（只读工具 allow，其余 ask）。
 * 硬 gate（路径围栏/命令黑名单）在工具内部、权限之外先拦，本类不负责。
 */
export class PermissionManager {
  private settings: PermissionSettings = { allow: [], deny: [] };
  private readonly settingsPath: string;
  private readonly registry?: ToolRegistry;
  private resolver?: Resolver;
  private readonly defaultForAsk: Decision;

  constructor(opts: PermissionOptions = {}) {
    this.settingsPath =
      opts.settingsPath ?? join(homedir(), '.config', 'agent-cli', 'settings.json');
    this.registry = opts.registry;
    this.resolver = opts.resolver;
    this.defaultForAsk = opts.defaultForAsk ?? 'deny';
  }

  /** 注入 HITL 提示器（REPL 在拿到 readline.Interface 后调用）；不注入则 ask 走 defaultForAsk */
  setResolver(r: Resolver): void {
    this.resolver = r;
  }

  /** 从磁盘加载已保存的 allow/deny 列表（不存在则跳过） */
  load(): void {
    if (!existsSync(this.settingsPath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.settingsPath, 'utf8')) as Partial<PermissionSettings>;
      this.settings = {
        allow: raw.allow ?? [],
        deny: raw.deny ?? [],
      };
    } catch {
      this.settings = { allow: [], deny: [] };
    }
  }

  /** 持久化当前 allow/deny 列表 */
  save(): void {
    mkdirSync(dirname(this.settingsPath), { recursive: true });
    writeFileSync(this.settingsPath, JSON.stringify(this.settings, null, 2), 'utf8');
  }

  private classify(tool: string): { readOnly: boolean; destructive: boolean } {
    const t = this.registry?.get(tool);
    return { readOnly: t?.isReadOnly ?? false, destructive: t?.isDestructive ?? false };
  }

  /** 纯策略决策（不同步用户） */
  decide(tool: string, detail = ''): Decision {
    const key = detail ? `${tool}:${detail}` : tool;
    if (this.settings.deny.includes(key) || this.settings.deny.includes(tool)) return 'deny';
    if (this.settings.allow.includes(key) || this.settings.allow.includes(tool)) return 'allow';
    return this.classify(tool).readOnly ? 'allow' : 'ask';
  }

  /** 同步决策，ask 时经 resolver（HITL）或 defaultForAsk 落地为布尔 */
  async resolve(tool: string, detail = '', resolver = this.resolver): Promise<boolean> {
    const d = this.decide(tool, detail);
    if (d === 'allow') return true;
    if (d === 'deny') return false;
    const r = resolver ? await resolver(tool, detail) : this.defaultForAsk;
    return r === 'allow';
  }

  /** 预批准某个工具（可选具体 detail），并持久化 */
  addAllow(tool: string, detail = ''): void {
    const key = detail ? `${tool}:${detail}` : tool;
    if (!this.settings.allow.includes(key)) this.settings.allow.push(key);
    if (this.settings.deny.includes(key)) this.settings.deny = this.settings.deny.filter((k) => k !== key);
    this.save();
  }

  getAllow(): string[] {
    return [...this.settings.allow];
  }
  getDeny(): string[] {
    return [...this.settings.deny];
  }
}
