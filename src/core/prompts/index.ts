// Phase 13：System Prompt 工程化（手写、零依赖）。
//
// 设计要点（与「散落硬编码字符串」的对比）：
// 1. 分块组合：系统提示拆成 identity / behavior / tool-policy / output-format / few-shot 五个职责单一的块，
//    各自可单独测试、替换、按需启用；builder 按顺序拼装，新增维度不改旧块。
// 2. 动态上下文注入：每次组 prompt 都用 gatherContext 注入 时间/cwd/OS/git 分支，
//    模型由此知道"此刻在哪"，避免凭空假设环境。
// 3. 工具策略与技能披露分离：工具使用策略是常驻块；技能清单（name+description）由调用方按需追加，
//    沿用 Phase 7 的「渐进式披露」——正文仍只在 use_skill 时加载。
// 4. 压缩子 prompt 统一收口：原本硬编码在 loop.ts 的压缩指令也收进本模块，
//    所有「写给模型的系统提示」集中管理，一处可维护。

import { gatherContext, type DynamicContext } from './context';

export { gatherContext } from './context';
export type { DynamicContext } from './context';

export interface AgentPromptContext {
  /** 工作目录（注入运行上下文） */
  cwd: string;
  /** 渐进式披露：技能 name+description 清单（来自 SkillLoader.menuText），可选 */
  skillsMenu?: string;
  /** 注入时间��默认 new Date()；单测可注入固定值保证确定性 */
  now?: Date;
}

// ── 可组合的系统提示块（每块职责单一） ──────────────
const identityBlock = (): string =>
  '你是一个运行在终端里的 AI 编程助手，类似 Claude Code。';

const behaviorBlock = (): string =>
  '用简洁、准确的中文回答用户的问题；优先动手用工具解决，而不是只给建议。';

const toolPolicyBlock = (): string =>
  '需要操作文件或执行命令时，优先调用工具：read_file / write_file / edit_file / list_dir / glob / grep / bash。' +
  '若已提供 rag_search 工具（本地知识库语义检索），在回答涉及项目文档、规范、历史决策等问题前，应先检索补充上下文。' +
  '若下方列出「可用技能」，在任务匹配时应调用 use_skill 获取其详细指令并严格遵循。';

const outputFormatBlock = (): string =>
  '回答结构：能用工具直接解决的，先动手再复述；解释性内容用要点（bullet）呈现，避免大段无关铺垫。' +
  '涉及代码改动时，优先用 edit_file / write_file 落地，并在回复中说明「改了什么、为什么」。';

const fewShotBlock = (): string =>
  '示例——用户：「把 utils.ts 里的 foo 改成异步」\n' +
  '你：① glob 定位 utils.ts → ② read_file 读取 → ③ edit_file 修改 → ④ 复述改动与理由。';

/** 把动态上下文渲染成「运行上下文」块 */
function contextBlock(dc: DynamicContext): string {
  const lines = [`当前时间：${dc.now}`, `工作目录：${dc.cwd}`, `运行环境：${dc.os}`];
  if (dc.gitBranch) lines.push(`当前 git 分支：${dc.gitBranch}`);
  return '【运行上下文】\n' + lines.join('\n');
}

const BLOCKS = [identityBlock, behaviorBlock, toolPolicyBlock, outputFormatBlock, fewShotBlock];

/**
 * 组装 Agent 主系统提示：分块组合 + 动态上下文注入 + 可选技能清单追加。
 * 返回的字符串可直接作为 ChatMessage(role:'system') 的 content。
 */
export function buildAgentSystemPrompt(ctx: AgentPromptContext): string {
  const dc = gatherContext(ctx.cwd, ctx.now);
  const parts = BLOCKS.map((b) => b());
  parts.push(contextBlock(dc));
  // 技能清单按需追加（渐进式披露：仅 name+description 常驻，正文仍按需加载）
  if (ctx.skillsMenu && ctx.skillsMenu.trim()) {
    parts.push(`可用技能：\n${ctx.skillsMenu.trim()}`);
  }
  return parts.join('\n\n');
}

/** 上下文压缩子调用的系统提示（原硬编码在 loop.ts，现统一收口于此） */
export function compressorSystemPrompt(): string {
  return '你是上下文压缩器。把下列对话历史压缩成简洁中文摘要，保留：关键事实、用户偏好、已做的决策、未完成的任务。不要编造。';
}
