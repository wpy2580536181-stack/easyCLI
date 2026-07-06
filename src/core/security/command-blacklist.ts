/**
 * 命令黑名单（硬 gate，不可关闭）：在 HITL 审批之前就拦掉明显破坏性的命令。
 * 这是「纵深防御」里最前的一道——正则黑名单比 Claude Code 的 tree-sitter AST 分析弱，
 * 但作为学习项目的第一道防线足够，且未来可升级为 AST 分析（见 §8.3）。
 */
const FORBIDDEN: RegExp[] = [
  /\brm\s+.*-r/i, // rm -rf / rm -r
  /\bsudo\b/i, // 提权
  /\bmkfs\b/i, // 格式化
  /\bdd\s+if=/i, // 磁盘写入
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bchmod\b.*\b777\b/i, // 提权式改权限（chmod 777 / chmod -R 777 等）
  /:\s*\/\s*>/, // 重定向覆写系统文件（粗略）
];

export function checkCommand(cmd: string): { ok: boolean; reason?: string } {
  for (const re of FORBIDDEN) {
    if (re.test(cmd)) return { ok: false, reason: `命令命中黑名单 (${re.source})` };
  }
  return { ok: true };
}
