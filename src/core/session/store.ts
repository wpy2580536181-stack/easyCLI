// Phase 9（会话持久化）：SessionStore —— 对话历史落盘。
//
// 设计要点：
//   - 每个会话一个 JSON 文件，存于 ~/.config/agent-cli/sessions/<name>.json。
//   - 存的是「纯对话流」（不含 system 提示）；加载时由调用方把当前 system 提示重新接回，
//     这样 skills 菜单等随版本变化的部分始终是新的，避免加载到过期的系统提示。
//   - 保存时复用 Phase 4 的 compressHistory 限长（默认不调摘要器、不联网），
//     避免长会话把会话文件/恢复上下文撑爆——这正是路线图说的「复用压缩 + 记忆存储模式」。
//   - 文件名做安全化（仅保留字母数字下划线连字符），防止路径穿越/注入。

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ChatMessage } from '../chatmodel/types';
import { compressHistory, type CompressOptions } from '../memory/compressor';

/** 会话目录（跨平台：~/.config/agent-cli/sessions） */
export const SESSION_DIR = join(homedir(), '.config', 'agent-cli', 'sessions');

/** 预留的「自动恢复」会话名：每轮结束后由 REPL 自动写入，供 --resume 使用 */
export const AUTOSAVE_NAME = 'autosave';

export interface SessionMeta {
  name: string;
  /** 最近更新时间（epoch ms） */
  updatedAt: number;
  /** 消息条数 */
  messageCount: number;
}

interface SessionFile {
  name: string;
  updatedAt: number;
  messages: ChatMessage[];
}

/** 从含 system 的 history 中抽出「纯对话流」（去掉 system 消息），供保存 */
export function extractConversation(history: ChatMessage[]): ChatMessage[] {
  return history.filter((m) => m.role !== 'system');
}

/** 把对话流重新接回 system 提示，得到可喂给 Agent 的完整 history */
export function withSystem(messages: ChatMessage[], systemContent: string): ChatMessage[] {
  return [{ role: 'system', content: systemContent }, ...messages];
}

export class SessionStore {
  constructor(private readonly dir: string = SESSION_DIR) {}

  private pathFor(name: string): string {
    const safe = name.replace(/[^a-zA-Z0-9_-]/g, '_');
    return join(this.dir, `${safe}.json`);
  }

  /**
   * 保存会话。messages 应为「纯对话流」（不含 system）。
   * 若提供 compress 选项且对话超预算，先用 compressHistory 限长（不调摘要器、不联网），
   * 让会话文件与恢复上下文都保持有界。
   */
  async save(name: string, messages: ChatMessage[], compress?: CompressOptions): Promise<void> {
    mkdirSync(this.dir, { recursive: true });
    const toSave =
      compress && messages.length > 1 ? await compressHistory(messages, compress) : messages;
    const data: SessionFile = { name, updatedAt: Date.now(), messages: toSave };
    writeFileSync(this.pathFor(name), JSON.stringify(data, null, 2), 'utf8');
  }

  load(name: string): ChatMessage[] | null {
    const p = this.pathFor(name);
    if (!existsSync(p)) return null;
    try {
      const data = JSON.parse(readFileSync(p, 'utf8')) as SessionFile;
      return Array.isArray(data.messages) ? data.messages : null;
    } catch {
      return null;
    }
  }

  exists(name: string): boolean {
    return existsSync(this.pathFor(name));
  }

  list(): SessionMeta[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => f.endsWith('.json'))
      .map((f): SessionMeta | null => {
        try {
          const data = JSON.parse(readFileSync(join(this.dir, f), 'utf8')) as SessionFile;
          if (!Array.isArray(data.messages)) return null;
          return { name: data.name, updatedAt: data.updatedAt, messageCount: data.messages.length };
        } catch {
          return null;
        }
      })
      .filter((x): x is SessionMeta => x !== null)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  remove(name: string): boolean {
    const p = this.pathFor(name);
    if (!existsSync(p)) return false;
    try {
      unlinkSync(p);
      return true;
    } catch {
      return false;
    }
  }
}
