// 输入框纯逻辑（无 React / ink）：斜杠筛选 + 回车决议。
//
// 抽出为纯函数以便单测，等价于旧 line-editor.ts 的 filtered() 与 handleEnter() 斜杠分支。

import type { CommandMeta } from '../cli/commands';

/** 斜杠命令筛选：输入以 / 开头时，按「命令全名包含子串」过滤（大小写不敏感）。 */
export function filterCommands(input: string, commands: readonly CommandMeta[]): CommandMeta[] {
  if (!input.startsWith('/')) return [];
  const q = input.slice(1).toLowerCase();
  return commands.filter((c) => c.name.toLowerCase().includes(q));
}

export type EnterDecision =
  | { kind: 'execute'; line: string } // 直接执行斜杠命令
  | { kind: 'fill'; input: string } // 把高亮项填回输入框继续编辑
  | { kind: 'submit'; line: string } // 普通文本 / 无匹配斜杠：原样提交
  | { kind: 'noop' }; // 无可提交内容

/**
 * 回车决议（对齐旧 handleEnter 的斜杠分支）：
 *  - 斜杠且有匹配：唯一匹配或已输全名 → execute；否则 fill 高亮项 + 空格。
 *  - 斜杠但无匹配：原样 submit（上层报未知命令）。
 *  - 普通文本：非空 submit。
 */
export function decideEnter(
  input: string,
  commands: readonly CommandMeta[],
  selIndex: number,
): EnterDecision {
  if (input.startsWith('/')) {
    const matches = filterCommands(input, commands);
    if (matches.length > 0) {
      const sel = matches[Math.max(0, Math.min(selIndex, matches.length - 1))];
      if (!sel) return { kind: 'noop' };
      const typed = input.slice(1).trim().toLowerCase();
      if (matches.length === 1 || typed === sel.name) {
        return { kind: 'execute', line: '/' + sel.name };
      }
      return { kind: 'fill', input: '/' + sel.name + ' ' };
    }
    return { kind: 'submit', line: input };
  }
  const t = input.trim();
  return t ? { kind: 'submit', line: t } : { kind: 'noop' };
}

/** 环形移动高亮下标（↑/↓）。 */
export function wrapIndex(cur: number, delta: number, len: number): number {
  if (len <= 0) return 0;
  return (((cur + delta) % len) + len) % len;
}

// —— @ 文件引用（蓝图维度 ④）——
export interface InputSegment {
  value: string;
  /** true 表示这是一个 `@path` 引用 token（需渲染为 chip）。 */
  ref: boolean;
}

/**
 * 把输入串切成「普通文本 / @引用」片段，供 InputBox 把 `@path` 渲染成高亮 chip。
 * 例：`帮 @src/a.ts 改` → [{value:'帮 ',ref:false},{value:'@src/a.ts',ref:true},{value:' 改',ref:false}]
 */
export function splitRefs(input: string): InputSegment[] {
  const parts = input.split(/(@[^\s@]+)/g);
  return parts.filter((p) => p !== '').map((p) => ({ value: p, ref: p.startsWith('@') }));
}

/**
 * 取光标前正在输入的 @引用 token（尚未以空格结束）。无则返回 null。
 * 例：input='@sr', cursor=3 → '@sr'；input='@sr ', cursor=4 → null。
 */
export function currentRefToken(input: string, cursor: number): string | null {
  const upto = input.slice(0, cursor);
  const m = upto.match(/@([^\s@]*)$/);
  return m ? '@' + m[1] : null;
}

/** 按 @token 过滤已知文件路径列表（空 query 返回全部）。 */
export function filterFiles(token: string, files: readonly string[]): string[] {
  if (!token.startsWith('@')) return [];
  const q = token.slice(1).toLowerCase();
  if (!q) return [...files];
  return files.filter((f) => f.toLowerCase().includes(q));
}

/** 把光标前的 @token 补全为 `@match `（保留其后文本）。 */
export function completeFileRef(input: string, cursor: number, match: string): string {
  const upto = input.slice(0, cursor).replace(/@([^\s@]*)$/, '@' + match + ' ');
  return upto + input.slice(cursor);
}
