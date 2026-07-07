import { describe, it, expect } from 'vitest';
import {
  buildAgentSystemPrompt,
  compressorSystemPrompt,
  gatherContext,
} from '../../src/core/prompts';

describe('prompts 模块（Phase 13）', () => {
  const fixedNow = new Date('2026-07-07T11:30:00Z');

  it('buildAgentSystemPrompt 包含各分块：身份/行为/工具策略/输出格式/few-shot/运行上下文', () => {
    const p = buildAgentSystemPrompt({ cwd: '/tmp/proj', now: fixedNow });
    expect(p).toContain('AI 编程助手'); // identity
    expect(p).toContain('用简洁、准确的中文'); // behavior
    expect(p).toContain('read_file / write_file'); // tool-policy
    expect(p).toContain('回答结构'); // output-format
    expect(p).toContain('示例'); // few-shot
    expect(p).toContain('【运行上下文】'); // 动态上下文块
    expect(p).toContain('/tmp/proj'); // cwd 注入
    expect(p).toContain('当前时间');
    expect(p).toContain('运行环境');
  });

  it('skillsMenu 提供时追加「可用技能」，缺失时不追加', () => {
    const withSkill = buildAgentSystemPrompt({
      cwd: '/tmp/proj',
      skillsMenu: '- foo: 做 foo 的事',
      now: fixedNow,
    });
    expect(withSkill).toContain('可用技能：');
    expect(withSkill).toContain('做 foo 的事');

    const without = buildAgentSystemPrompt({ cwd: '/tmp/proj', now: fixedNow });
    expect(without).not.toContain('可用技能：');
  });

  it('skillsMenu 为空白/空串时不追加，避免空块', () => {
    const empty = buildAgentSystemPrompt({ cwd: '/tmp/proj', skillsMenu: '   ', now: fixedNow });
    expect(empty).not.toContain('可用技能：');
  });

  it('gatherContext 注入时间与 OS；非 git 目录 git 分支为 undefined 且不抛', () => {
    const dc = gatherContext('/nonexistent_dir_xyz_999', fixedNow);
    expect(dc.now).toContain('2026'); // 本地化时间含年份
    expect(dc.os).toMatch(/linux|darwin|win32/i);
    expect(dc.gitBranch).toBeUndefined(); // 不存在的目录 → 非 git → undefined
  });

  it('gatherContext 在真实 git 仓库内能取到分支（当前仓库）', () => {
    const dc = gatherContext(process.cwd(), fixedNow);
    // 当前 easyCLI 是 git 仓库，应能取到分支名（非空字符串）
    expect(typeof dc.gitBranch === 'string' && dc.gitBranch.length > 0).toBe(true);
  });

  it('compressorSystemPrompt 返回压缩指令且与原硬编码语义一致', () => {
    expect(compressorSystemPrompt()).toContain('上下文压缩器');
    expect(compressorSystemPrompt()).toContain('不要编造');
  });

  it('固定 now 使输出确定性（可断言时间片段）', () => {
    const dc = gatherContext('/x', fixedNow);
    // zh-CN 24h 格式含 "2026" 与 "11:30"（UTC 下）
    expect(dc.now).toContain('2026');
  });
});
