import type { ToolDef } from '../chatmodel/types';
import type { SkillLoader } from './loader';

/**
 * Skill 工具：把技能系统接入统一 ToolRegistry。
 * - use_skill：模型在合适的场景调用，传入技能 name，取回其完整指令正文，
 *   随后在本轮「遵循该指令」行动。正文经渐进披露只在被调用时才进入上下文。
 * isReadOnly=true → 走执行器「只读并行」分支，默认权限放行。
 */
export function getSkillTools(loader: SkillLoader): ToolDef[] {
  return [
    {
      name: 'use_skill',
      description:
        '加载并使用一个已注册技能（skill）的完整操作指令。传入技能 name，返回其详细指引，供你在本轮严格遵循。' +
        '当任务匹配「可用技能」列表中的某项时，应主动调用本工具。',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string', description: '技能名称' } },
        required: ['name'],
      },
      isReadOnly: true,
      isDestructive: false,
      execute: async (args: Record<string, unknown>) => {
        const name = typeof args.name === 'string' ? args.name.trim() : '';
        if (!name) return { ok: false, output: '缺少参数 name' };
        const skill = loader.load(name);
        if (!skill) return { ok: false, output: `未找到技能: ${name}` };
        return { ok: true, output: `# 技能：${skill.name}\n\n${skill.body.trim()}` };
      },
    },
  ];
}
