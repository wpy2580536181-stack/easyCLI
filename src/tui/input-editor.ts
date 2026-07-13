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
