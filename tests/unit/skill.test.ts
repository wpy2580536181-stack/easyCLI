import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillLoader, getSkillTools, parseFrontmatter } from '../../src/core/skill';
import type { SkillSource } from '../../src/core/skill';
import { createToolRegistry } from '../../src/core/tools/registry';
import { PermissionManager } from '../../src/core/security/permission';
import { runAgent } from '../../src/core/agent';
import type { ChatMessage, ChatModel, CompleteResult, ToolCall } from '../../src/core/chatmodel/types';

let base: string;
let builtinDir: string;
let userDir: string;
let projectDir: string;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'easycli-skill-'));
  builtinDir = join(base, 'builtin');
  userDir = join(base, 'user');
  projectDir = join(base, 'project');
  await mkdir(builtinDir, { recursive: true });
  await mkdir(userDir, { recursive: true });
  await mkdir(projectDir, { recursive: true });

  // 三层同名技能「greet」：每层 description 不同，验证覆盖语义（project > user > builtin）
  await writeFile(
    join(builtinDir, 'greet.md'),
    [
      '---',
      'name: greet',
      'description: builtin 层的问候技能',
      'tags: [demo]',
      '---',
      '这是内置技能正文，不应出现在 system prompt。',
    ].join('\n'),
    'utf8',
  );
  await writeFile(
    join(userDir, 'greet.md'),
    [
      '---',
      'name: greet',
      'description: user 层的问候技能',
      '---',
      '这是用户层技能正文。',
    ].join('\n'),
    'utf8',
  );
  await writeFile(
    join(projectDir, 'greet.md'),
    [
      '---',
      'name: greet',
      'description: project 层的问候技能（最优先）',
      '---',
      '这是项目层技能正文，包含关键指令：必须先说「你好」再介绍自己。',
    ].join('\n'),
    'utf8',
  );

  // 一个只在 project 层出现的技能
  await writeFile(
    join(projectDir, 'review.md'),
    [
      '---',
      'name: review',
      'description: 代码审查技能',
      '---',
      '审查步骤：1) 读改动 2) 查风险 3) 给建议。',
    ].join('\n'),
    'utf8',
  );

  // 嵌套子目录里的技能（验证 walk 递归）
  await mkdir(join(projectDir, 'sub'), { recursive: true });
  await writeFile(
    join(projectDir, 'sub', 'deploy.md'),
    ['---', 'name: deploy', 'description: 部署技能', '---', '部署正文。'].join('\n'),
    'utf8',
  );

  // 不合法：无 frontmatter
  await writeFile(join(projectDir, 'plain.md'), '只是普通 markdown，没有 frontmatter。', 'utf8');
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('parseFrontmatter 手写 YAML 解析', () => {
  it('解析标量 key: value', () => {
    const { fm, body } = parseFrontmatter('---\nname: foo\n---\n正文内容');
    expect(fm.name).toBe('foo');
    expect(body).toBe('正文内容');
  });

  it('解析单行数组 key: [a, b]', () => {
    const { fm } = parseFrontmatter('---\nname: foo\ntags: [a, b, c]\n---');
    expect(fm.tags).toEqual(['a', 'b', 'c']);
  });

  it('没有 --- 块时整体视为 body，fm 为空', () => {
    const { fm, body } = parseFrontmatter('就是一段普通文本');
    expect(fm).toEqual({});
    expect(body).toBe('就是一段普通文本');
  });

  it('空值行被跳过（不塞进 fm）', () => {
    const { fm } = parseFrontmatter('---\nname: foo\nnote:\nversion: 2\n---');
    expect(fm).toEqual({ name: 'foo', version: '2' });
  });

  it('兼容 CRLF 换行', () => {
    const { fm } = parseFrontmatter('---\r\nname: foo\r\n---\r\nbody');
    expect(fm.name).toBe('foo');
  });
});

describe('SkillLoader 三层加载 + 同名覆盖', () => {
  // 注意：sources 必须在 it 内构造（beforeAll 才已填充各 dir 路径），
  // 不能在 describe 顶层求值，否则 dir 在收集阶段仍是 undefined。
  const makeSources = (): SkillSource[] => [
    { layer: 'builtin', dir: builtinDir },
    { layer: 'user', dir: userDir },
    { layer: 'project', dir: projectDir },
  ];

  it('index 返回全部技能，且同名按 project > user > builtin 覆盖', () => {
    const loader = new SkillLoader(makeSources());
    const metas = loader.index();
    const greet = metas.find((m) => m.name === 'greet');
    expect(greet).toBeDefined();
    // project 层最优先
    expect(greet!.description).toBe('project 层的问候技能（最优先）');
    expect(greet!.layer).toBe('project');
  });

  it('递归 walk 能发现子目录里的技能', () => {
    const loader = new SkillLoader(makeSources());
    const names = loader.index().map((m) => m.name).sort();
    expect(names).toEqual(['deploy', 'greet', 'review']);
  });

  it('无 frontmatter 的 .md 被忽略', () => {
    const loader = new SkillLoader([{ layer: 'project', dir: projectDir }]);
    expect(loader.index().map((m) => m.name)).not.toContain('plain');
  });

  it('缺失目录不报错（优雅跳过）', () => {
    const loader = new SkillLoader([{ layer: 'project', dir: join(base, 'not-exist') }]);
    expect(loader.index()).toEqual([]);
  });

  it('list() 与 index() 等价；menuText 仅含 name+description，不泄漏 body', () => {
    const loader = new SkillLoader(makeSources());
    expect(loader.list().length).toBe(3);
    const menu = loader.menuText();
    expect(menu).toContain('greet');
    expect(menu).toContain('project 层的问候技能（最优先）');
    // 渐进式披露：正文不应进入菜单文本
    expect(menu).not.toContain('这是项目层技能正文');
    expect(menu).not.toContain('关键指令');
  });
});

describe('use_skill 经执行器跑通一轮（渐进披露触发）', () => {
  class ScriptedModel implements ChatModel {
    readonly id = 'mock:test';
    calls = 0;
    constructor(private readonly queue: CompleteResult[]) {}
    async complete(): Promise<CompleteResult> {
      const r = this.queue[this.calls % this.queue.length]!;
      this.calls++;
      return r;
    }
  }

  it('模型调用 use_skill 后，技能正文被注入历史供其遵循', async () => {
    const loader = new SkillLoader([{ layer: 'project', dir: projectDir }]);
    const tools = createToolRegistry();
    tools.registerAll(getSkillTools(loader));
    // use_skill 标记 isReadOnly → 默认权限放行，无需 resolver
    const permission = new PermissionManager({ registry: tools });

    const call: ToolCall = {
      id: 's1',
      name: 'use_skill',
      arguments: { name: 'greet' },
    };
    const model = new ScriptedModel([
      { content: '我先加载问候技能', toolCalls: [call] },
      { content: '你好，我是 easyCLI 助手。', toolCalls: [] },
    ]);
    const history: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '跟我打个招呼' },
    ];

    await runAgent(history, { model, tools, permission, cwd: process.cwd() });

    const toolMsg = history[3]!;
    expect(toolMsg.role).toBe('tool');
    // 正文被回填进工具结果
    expect(String(toolMsg.content)).toContain('这是项目层技能正文');
    expect(String(toolMsg.content)).toContain('必须先说「你好」');
  });

  it('加载不存在的技能返回友好错误', async () => {
    const loader = new SkillLoader([{ layer: 'project', dir: projectDir }]);
    const tools = createToolRegistry();
    tools.registerAll(getSkillTools(loader));
    const permission = new PermissionManager({ registry: tools });
    const call: ToolCall = {
      id: 's2',
      name: 'use_skill',
      arguments: { name: 'nope' },
    };
    const model = new ScriptedModel([
      { content: '试试不存在的技能', toolCalls: [call] },
      { content: '已处理', toolCalls: [] },
    ]);
    const history: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '用 nope 技能' },
    ];
    await runAgent(history, { model, tools, permission, cwd: process.cwd() });
    const toolMsg = history[3]!;
    expect(String(toolMsg.content)).toContain('未找到技能');
  });
});
