import { describe, it, expect, vi, afterEach } from 'vitest';
import { printSplash } from '../../src/cli/splash';

/** 临时设置 process.stdout.columns 并恢复 */
function withColumns(cols: number, fn: () => void): void {
  const orig = (process.stdout as unknown as { columns: number | undefined }).columns;
  (process.stdout as unknown as { columns: number | undefined }).columns = cols;
  try {
    fn();
  } finally {
    (process.stdout as unknown as { columns: number | undefined }).columns = orig;
  }
}

/** 去掉 ANSI 后的可视字符长度 */
function visibleLen(s: string): number {
  const strip = s.replace(/\x1b\[[0-9;]*m/g, '');
  let w = 0;
  for (const ch of strip) w += ch.charCodeAt(0) > 0x2e80 ? 2 : 1;
  return w;
}

describe('printSplash（启动欢迎框）', () => {
  afterEach(() => vi.restoreAllMocks());

  it('渲染双栏圆角框：顶/底边圆角、含品牌标题与右栏分隔线', () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((s) => logs.push(String(s)));
    let ret: string[] = [];
    withColumns(80, () => {
      ret = printSplash({ modelId: 'openai:agnes-2.0-flash' });
    });
    spy.mockRestore();

    // 直接打印与返回值一致
    expect(logs).toEqual(ret);
    expect(ret.length).toBeGreaterThan(5);

    // 顶边：圆角 + 品牌标题
    expect(ret[0]).toContain('╭');
    expect(ret[0]).toContain('╮');
    expect(ret[0]).toContain('easyCLI v');

    // 底边：圆角 + 操作提示
    const bottom = ret[ret.length - 1];
    expect(bottom).toContain('╰');
    expect(bottom).toContain('╯');
    expect(bottom).toContain('Ctrl+C to abort');

    // 中间每一行都有左右两栏分隔线 │
    const body = ret.slice(1, -1);
    expect(body.length).toBeGreaterThan(0);
    expect(body.every((l) => l.includes('│'))).toBe(true);

    // 左栏运行信息 + 右栏能力速览
    const all = ret.join('\n');
    expect(all).toContain('Capabilities');
    expect(all).toContain('ReAct loop + Tool Calling');
    expect(all).toContain('Multi-Agent collaboration');
  });

  it('内宽 clamp 到 [70,90]：超窄/超宽终端都不溢出', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    let narrow: string[] = [];
    let wide: string[] = [];
    withColumns(40, () => {
      narrow = printSplash({ modelId: 'm' });
    });
    withColumns(200, () => {
      wide = printSplash({ modelId: 'm' });
    });
    spy.mockRestore();

    // 顶边去掉首尾圆角后的可视宽度 = 内宽
    const inner = (l: string | undefined) => visibleLen(l ?? '') - 2;
    expect(inner(narrow[0])).toBe(70); // 窄终端被 clamp 到 70
    expect(inner(wide[0])).toBe(90); //  宽终端被 clamp 到 90
  });
});
