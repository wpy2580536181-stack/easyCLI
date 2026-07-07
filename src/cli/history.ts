// Phase 10（REPL 体验打磨）：跨会话命令历史文件。
//
// 位置：~/.config/agent-cli/history（与 config / session / audit 同目录约定，复用「用户配置目录」范式）。
// 作用：把用户在 REPL 里敲过的命令（含 slash 命令与多行粘贴）持久化，
// 下次启动读回并 seed 进 readline 的 rl.history，使 ↑/↓ 可跨会话翻历史。
//
// 设计要点：
//   - readline 自带 history 只在内存里、且不落盘；这里手写落盘，完全掌控读写。
//   - 落盘前按「连续重复」去重，避免同一命令刷屏污染历史。
//   - 限长（MAX_HISTORY）， oldest 先出，控制文件体积。
//   - 文件按「旧 → 新」追加；seed 进 readline 时需反转成「新 → 旧」（rl.history[0] 是最新）。

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

/** 历史文件绝对路径（跨平台：~/.config/agent-cli/history） */
export const HISTORY_PATH = join(homedir(), '.config', 'agent-cli', 'history');

/** 历史最大保留条数（超出后最旧的先被丢弃） */
const MAX_HISTORY = 2000;

/**
 * 命令历史存储。REPL 启动时构造一次：读回旧历史；每条命令处理完调用 add 落盘。
 */
export class HistoryStore {
  /** 内存中的历史，顺序为「旧 → 新」（与文件一致） */
  private lines: string[] = [];

  constructor(private readonly path: string = HISTORY_PATH) {
    if (existsSync(this.path)) {
      try {
        const raw = readFileSync(this.path, 'utf8');
        // 过滤掉文件末尾可能的空行；保留内部空行（多行粘贴会含空行）
        this.lines = raw.split('\n').filter((l, i, arr) => !(i === arr.length - 1 && l === ''));
      } catch {
        this.lines = [];
      }
    }
  }

  /** 供 readline 初始化的历史：反转为「新 → 旧」，匹配 rl.history[0] = 最新 的语义 */
  forReadline(): string[] {
    return [...this.lines].reverse();
  }

  /** 当前历史条数（调试/测试用） */
  get size(): number {
    return this.lines.length;
  }

  /**
   * 追加一条命令到历史（仅在非连续重复时），并落盘。
   * 任何 I/O 异常都静默吞掉——历史写入失败绝不应打断对话。
   */
  add(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    // 连续重复去重：刚敲过一模一样的就不再记
    if (this.lines[this.lines.length - 1] === trimmed) return;
    this.lines.push(trimmed);
    const over = this.lines.length > MAX_HISTORY;
    if (over) {
      // 超限：内存只保留最近 MAX_HISTORY 条，文件也需整体重写以真正限长
      // （只有超过上限后才会触发重写，正常一次会话极少敲到 2000 条，故近乎 append-only）
      this.lines = this.lines.slice(this.lines.length - MAX_HISTORY);
    }
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      if (over) {
        writeFileSync(this.path, this.lines.join('\n') + '\n', 'utf8');
      } else {
        appendFileSync(this.path, trimmed + '\n', 'utf8');
      }
    } catch {
      /* 历史写入失败静默忽略 */
    }
  }
}
