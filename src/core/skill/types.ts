// Phase 7（Skill 系统）：Skill 类型 + 手写 YAML frontmatter 解析。
//
// 一个 Skill 本质是一份「可复用的能力/指令包」：用 markdown 文件描述「何时用、怎么用」。
// 手写解析而非引 yaml 库，契合「纯手写不引 SDK」约束，也把 frontmatter 这种
// 常见格式的解析原理讲透（它其实就是「--- 之间的 key: value 块」）。

export type SkillLayer = 'builtin' | 'user' | 'project';

/** 一个技能来源目录（三层加载中的某一层） */
export interface SkillSource {
  layer: SkillLayer;
  dir: string;
}

/** 从 frontmatter 解析出的元数据 */
export interface SkillFrontmatter {
  name: string;
  description: string;
  tags?: string[];
}

/** 技能元数据（含来源层与文件路径，用于索引与渐进披露） */
export interface SkillMeta extends SkillFrontmatter {
  layer: SkillLayer;
  path: string;
}

/** 完整技能（元数据 + 正文指令） */
export interface Skill extends SkillMeta {
  body: string;
}

/**
 * 极简 YAML frontmatter 解析：只支持 `key: value` 与单行 `key: [a, b]` 数组。
 * 对 Skill 场景足够；不追求完整 YAML 语义（那是另一个学习主题）。
 */
export function parseFrontmatter(raw: string): { fm: Record<string, unknown>; body: string } {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { fm: {}, body: raw };
  const fm: Record<string, unknown> = {};
  const header = m[1] ?? '';
  const body = m[2] ?? '';
  for (const line of header.split('\n')) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    const rawVal = line.slice(idx + 1).trim();
    if (rawVal === '') continue;
    if (rawVal.startsWith('[') && rawVal.endsWith(']')) {
      const inner = rawVal.slice(1, -1);
      fm[key] = inner
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    } else {
      fm[key] = rawVal;
    }
  }
  return { fm, body };
}
