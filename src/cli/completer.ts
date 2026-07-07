// Phase 10（REPL 体验打磨）：基础 Tab 补全。
//
// 把补全逻辑抽成纯函数 completeLine，便于单测，也便于在 readline 的 completer 选项里直接复用。
//
// 补全策略：
//   1. 输入以 '/' 开头 → 在 SLASH_COMMANDS 中按前缀匹配命令名（返回 '/xxx' 形式）。
//   2. 否则（普通聊天文本）→ 在历史记录里按前缀匹配，补出曾经敲过的相似句子。
//
// readline 的 completer 契约：返回 [候选数组, 被补全的子串]。
// 候选必须是「完整候选值」（含已敲部分）；readline 自己算公共前缀并替换。

/** REPL 支持的全部 slash 命令（与 handleSlash 的 case 保持一致） */
export const SLASH_COMMANDS: readonly string[] = [
  'exit',
  'quit',
  'clear',
  'model',
  'tools',
  'perm',
  'config',
  'rag',
  'skills',
  'skill',
  'save',
  'load',
  'sessions',
  'session',
  'rm',
  'help',
  'prompt',
] as const;

export interface CompletionResult {
  /** 候选补全（完整值，含已敲部分） */
  hits: string[];
  /** 被补全的子串（原样回传即可） */
  line: string;
}

/**
 * 给定当前行，计算补全候选。
 * @param line      光标所在行的文本（readline 会传入）
 * @param commands  slash 命令名列表（默认 SLASH_COMMANDS）
 * @param history   历史记录（用于普通文本补全），默认空
 */
export function completeLine(
  line: string,
  commands: readonly string[] = SLASH_COMMANDS,
  history: readonly string[] = [],
): CompletionResult {
  if (line.startsWith('/')) {
    const partial = line.slice(1);
    const matches = commands.filter((c) => c.startsWith(partial));
    return { hits: matches.map((c) => '/' + c), line };
  }
  // 普通文本：从历史里挑「以当前行开头、且不等于当前行」的条目
  const matches = history
    .filter((h) => h.startsWith(line) && h !== line)
    .slice(0, 20);
  return { hits: matches, line };
}
