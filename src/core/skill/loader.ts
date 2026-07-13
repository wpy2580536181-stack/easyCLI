// Phase 7（Skill 系统）：SkillLoader —— 三层加载 + 渐进式披露。
//
// 三层来源（由「稳」到「易变」，覆盖度递增）：
//   - builtin ：随 CLI 发布的内置技能（可选）
//   - user    ：~/.config/agent-cli/skills（跨项目个人技能）
//   - project ：./.agent/skills（当前仓库专属技能，最优先）
// 同名时「上层覆盖下层」（project > user > builtin），让项目能定制/屏蔽内置技能。
//
// 渐进式披露（Progressive Disclosure）：
//   - index()/menuText() 只暴露 name + description（轻量、稳定）→ 放进常驻 system prompt，
//     命中 prompt cache、不撑爆上下文；
//   - 正文指令（body）仅在模型真正调用 use_skill 时才加载，不预先塞满。

import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import fg from 'fast-glob';
import { parseFrontmatter, type Skill, type SkillLayer, type SkillMeta, type SkillSource } from './types';

const LAYER_ORDER: SkillLayer[] = ['builtin', 'user', 'project'];

/**
 * 技能加载器：扫描三层来源、解析元数据、按需加载正文。
 * 不变量：index() 返回的每个 name 唯一（上层覆盖下层），供 system prompt 稳定展示。
 */
export class SkillLoader {
  constructor(private readonly sources: SkillSource[]) {}

  /** 扫描全部层，解析 frontmatter，返回元数据（同名按层序覆盖） */
  index(): SkillMeta[] {
    const byName = new Map<string, SkillMeta>();
    for (const layer of LAYER_ORDER) {
      for (const src of this.sources.filter((s) => s.layer === layer)) {
        if (!existsSync(src.dir)) continue;
        for (const rel of fg.sync('**/*.md', { cwd: src.dir, dot: true })) {
          const file = join(src.dir, rel);
          let raw: string;
          try {
            raw = readFileSync(file, 'utf8');
          } catch {
            continue;
          }
          const { fm } = parseFrontmatter(raw);
          const name = typeof fm.name === 'string' ? fm.name : '';
          if (!name) continue;
          byName.set(name, {
            name,
            description: typeof fm.description === 'string' ? fm.description : '',
            tags: Array.isArray(fm.tags) ? (fm.tags as string[]) : [],
            layer: src.layer,
            path: file,
          });
        }
      }
    }
    return [...byName.values()];
  }

  /** 加载某个技能的完整正文（含元数据）；不存在返回 undefined */
  load(name: string): Skill | undefined {
    const meta = this.index().find((m) => m.name === name);
    if (!meta) return undefined;
    let body = '';
    try {
      body = parseFrontmatter(readFileSync(meta.path, 'utf8')).body;
    } catch {
      body = '';
    }
    return { ...meta, body };
  }

  /**
   * 渐进式披露文本：只列 name + description，供常驻 system prompt 使用。
   * 轻量且随技能集合稳定变化，有利于 prompt cache 命中。
   */
  menuText(): string {
    return this.menuTextExcluding([]);
  }

  /**
   * 渐进式披露文本，但排除指定技能名（Phase 22：已被自动注入正文的技能不再列入菜单，
   * 避免系统提示既「常驻正文」又「要求 use_skill 按需加载」造成重复触发与回合浪费）。
   */
  menuTextExcluding(exclude: string[]): string {
    const skip = new Set(exclude.map((n) => n.trim()).filter(Boolean));
    const list = this.index().filter((s) => !skip.has(s.name));
    if (list.length === 0) return '';
    const lines = list.map((s) => `- ${s.name}：${s.description}`);
    return `可用技能（按需调用 use_skill 获取详细指令）：\n${lines.join('\n')}`;
  }

  /** 当前已索引的技能名列表（/skills 命令用） */
  list(): SkillMeta[] {
    return this.index();
  }

  /**
   * Phase 22：自动注入块。
   * 把指定技能的正文拼成一段系统提示文本——是「渐进式披露（按需 use_skill）」的对称：
   * 这些技能的正文每轮自动进系统提示，无需模型主动调用。
   * 仅拼入实际存在的技能正文；不存在 / 正文为空的 name 静默跳过（不报错、不阻断启动）。
   * 返回空串表示没有任何技能可注入。
   */
  autoInjectBlock(names: string[]): string {
    const blocks = names
      .map((n) => n.trim())
      .filter(Boolean)
      .map((n) => this.load(n))
      .filter((s): s is Skill => !!s && !!s.body.trim())
      .map((s) => `### 技能：${s.name}\n${s.body.trim()}`);
    if (blocks.length === 0) return '';
    return (
      '【始终生效的技能指令】（以下技能正文已每轮自动注入、直接生效；你必须严格遵循其中的全部指令与输出格式，无需再调用 use_skill）\n' +
      blocks.join('\n\n')
    );
  }
}

/** 判断某文件是否为合法 skill（有 frontmatter 且含 name） */
export function isValidSkillFile(path: string): boolean {
  if (!existsSync(path) || !statSync(path).isFile()) return false;
  try {
    const { fm } = parseFrontmatter(readFileSync(path, 'utf8'));
    return typeof fm.name === 'string' && fm.name.length > 0;
  } catch {
    return false;
  }
}
