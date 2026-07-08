// 全部 slash 命令的「单一事实来源」：命令名 + 一句话说明。
//
// 过去命令说明只硬编码在 repl.ts 的 printHelp() 里，导致没法在输入时弹出带说明的菜单。
// 现在统一抽到这里，/help 与 REPL 的斜杠命令下拉菜单共用同一份数据，避免漂移。

export interface CommandMeta {
  /** 命令名（不含前导 /），如 "exit" */
  name: string;
  /** 一句话说明，用于 /help 与下拉菜单 */
  description: string;
}

/** REPL 支持的全部 slash 命令（与 handleSlash 的 switch case 保持一致） */
export const COMMANDS: readonly CommandMeta[] = [
  { name: 'help', description: '显示本帮助' },
  { name: 'clear', description: '清空对话上下文（保留系统提示）' },
  { name: 'model', description: '显示当前模型' },
  { name: 'tools', description: '显示已注册工具' },
  { name: 'cost', description: '显示本次会话的用量与成本' },
  { name: 'plan', description: '进入规划模式，只读探测并生成执行计划（/plan <任务>）' },
  { name: 'approve', description: '批准当前计划并进入执行' },
  { name: 'discard', description: '放弃当前计划并回滚' },
  { name: 'autoctx', description: '开关每轮自动注入记忆/知识库上下文' },
  { name: 'agent', description: '多 Agent 协作：规划 + 并发 Worker（隔离 worktree）+ 评审' },
  { name: 'rag', description: '知识库：/rag search|ingest|reindex|status' },
  { name: 'skills', description: '列出已加载技能' },
  { name: 'skill', description: '查看某技能的完整指令（/skill <name>）' },
  { name: 'perm', description: '显示当前权限允许/拒绝列表' },
  { name: 'config', description: '查看当前生效配置（/config save 持久化）' },
  { name: 'save', description: '保存当前会话（/save [名称]）' },
  { name: 'load', description: '载入已保存会话（/load [名称]）' },
  { name: 'sessions', description: '列出所有已保存会话' },
  { name: 'session', description: '预览某会话内容（/session <名称>）' },
  { name: 'rm', description: '删除某会话（/rm <名称>）' },
  { name: 'prompt', description: '单次提问（不进入多轮，/prompt <文本>）' },
  { name: 'exit', description: '退出' },
  { name: 'quit', description: '退出' },
];
