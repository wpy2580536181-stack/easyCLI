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
// 5. Phase 15：规划模式（plan）复用同一套分块底座，仅追加「约束 + 产出格式」块，
//    不另起炉灶——保证规划与执行走同一引擎、同一提示底座。

import { gatherContext, type DynamicContext } from './context';

export { gatherContext } from './context';
export type { DynamicContext } from './context';

/** Agent 运行模式：normal=正常 ReAct 执行；plan=规划模式（只读探测 + 产出计划待批准） */
export type AgentMode = 'normal' | 'plan';

export interface AgentPromptContext {
  /** 工作目录（注入运行上下文） */
  cwd: string;
  /** 已注册工具名列表（来自 ToolRegistry.list()）；工具策略块据此动态生成，避免手写不同步 */
  toolNames?: string[];
  /** 渐进式披露：技能 name+description 清单（来自 SkillLoader.menuText），可选 */
  skillsMenu?: string;
  /** 注入时间；默认 new Date()；单测可注入固定值保证确定性 */
  now?: Date;
  /** 运行模式；plan 模式会追加「仅只读 + 产出计划」指令（Phase 15） */
  mode?: AgentMode;
}

// ── 可组合的系统提示块（每块职责单一） ──────────────
const identityBlock = (): string =>
  '你是一个运行在终端里的 AI 编程助手，类似 Claude Code。';

const behaviorBlock = (): string =>
  '用简洁、准确的中文回答用户的问题；优先动手用工具解决，而不是只给建议。';

/** 语义上需单独给「使用时机」指引的工具（名称属项目契约）；其余工具直接列入「优先可用的工具」 */
const NON_GENERAL_TOOLS = new Set(['web_search', 'web_fetch', 'rag_search', 'use_skill']);

const toolPolicyBlock = (toolNames: string[]): string => {
  const parts: string[] = ['需要完成任务时，优先调用可用工具，而不是只给建议。'];
  // 通用工具名称直接来自注册表：保证提示与真正可调用的工具一致，消除手写不同步
  const generalTools = toolNames.filter((n) => !NON_GENERAL_TOOLS.has(n));
  if (generalTools.length) parts.push(`优先可用的工具：${generalTools.join(' / ')}。`);
  // 以下三类按「是否注册」条件出现：注册了才提示使用时机，绝不谎称存在
  if (toolNames.includes('web_search')) {
    parts.push(
      '已提供 web_search（联网搜索）：当问题涉及实时信息、最新事件、你不确定或可能过期的外部知识时，应先调用 web_search 检索，再据此回答；需要某条结果的网页正文时用 web_fetch。',
    );
  }
  if (toolNames.includes('rag_search')) {
    parts.push(
      '已提供 rag_search（本地知识库语义检索）：在回答涉及项目文档、规范、历史决策等问题前，应先检索补充上下文。',
    );
  }
  if (toolNames.includes('use_skill')) {
    parts.push('若下方列出「可用技能」，在任务匹配时应调用 use_skill 获取其详细指令并严格遵循。');
  }
  return parts.join('');
};

const outputFormatBlock = (): string =>
  '回答结构：能用工具直接解决的，先动手再复述；解释性内容用要点（bullet）呈现，避免大段无关铺垫。' +
  '涉及代码改动时，优先用 edit_file / write_file 落地，并在回复中说明「改了什么、为什么」。';

const fewShotBlock = (): string =>
  '示例——用户：「把 utils.ts 里的 foo 改成异步」\n' +
  '你：① glob 定位 utils.ts → ② read_file 读取 → ③ edit_file 修改 → ④ 复述改动与理由。';

/**
 * 规划模式指令块（Phase 15）。
 * 与正常模式共用同一套身份/行为块，仅追加「约束 + 产出格式」，
 * 不另起炉灶——保证规划与执行走同一引擎、同一提示底座。
 */
const planModeBlock = (): string =>
  '【规划模式】你当前处于规划模式，目标是先理解任务、再给出可执行的实施计划，而不是直接改动任何东西。\n' +
  '约束：\n' +
  '1. 只能调用只读工具（read_file / list_dir / glob / grep / bash 只读探测等）去收集上下文；不要调用任何会写文件或执行破坏性命令的工具。\n' +
  '2. 不要做任何实际改动，也不要假装已经改完。\n' +
  '3. 探索充分后，输出一份结构化计划（用中文、Markdown），包含：\n' +
  '   - 目标：要解决什么；\n' +
  '   - 现状/发现：你通过只读工具确认到的关键事实；\n' +
  '   - 步骤：编号的 execution 步骤，每步注明会用到的工具与预期产物；\n' +
  '   - 风险与待确认：需要用户拍板的点。\n' +
  '4. 输出计划即结束本轮，等待用户批准后再进入执行。';

/** 把动态上下文渲染成「运行上下文」块 */
function contextBlock(dc: DynamicContext): string {
  const lines = [`当前时间：${dc.now}`, `工作目录：${dc.cwd}`, `运行环境：${dc.os}`];
  if (dc.gitBranch) lines.push(`当前 git 分支：${dc.gitBranch}`);
  return '【运行上下文】\n' + lines.join('\n');
}

/**
 * 组装 Agent 主系统提示：分块组合 + 动态上下文注入 + 可选技能清单追加。
 * 返回的字符串可直接作为 ChatMessage(role:'system') 的 content。
 * mode='plan' 时追加规划模式约束块（Phase 15）。工具策略块的工具名由调用方
 * 从 ToolRegistry 传入（ctx.toolNames），保证与真正可调用的工具一致。
 */
export function buildAgentSystemPrompt(ctx: AgentPromptContext): string {
  const dc = gatherContext(ctx.cwd, ctx.now);
  const parts = [
    identityBlock(),
    behaviorBlock(),
    toolPolicyBlock(ctx.toolNames ?? []),
    outputFormatBlock(),
    fewShotBlock(),
    contextBlock(dc),
  ];
  if (ctx.mode === 'plan') parts.push(planModeBlock());
  // 技能清单按需追加（渐进式披露：仅 name+description 常驻，正文仍按需加载）
  if (ctx.skillsMenu && ctx.skillsMenu.trim()) {
    parts.push(`可用技能：\n${ctx.skillsMenu.trim()}`);
  }
  return parts.join('\n\n');
}

/** 规划模式系统提示（Phase 15）：正常提示 + 规划约束块，供 REPL/main 切模式时直接替换 system 消息 */
export function buildPlanSystemPrompt(ctx: AgentPromptContext): string {
  return buildAgentSystemPrompt({ ...ctx, mode: 'plan' });
}

/** 上下文压缩子调用的系统提示（原硬编码在 loop.ts，现统一收口于此） */
export function compressorSystemPrompt(): string {
  return '你是上下文压缩器。把下列对话历史压缩成简洁中文摘要，保留：关键事实、用户偏好、已做的决策、未完成的任务。不要编造。';
}
