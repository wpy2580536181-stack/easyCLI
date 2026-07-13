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

  it('渲染双栏方角框：顶/底边方角、含能力栏与右栏分隔线', () => {
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

    // 顶边：纯方角框（品牌大字标题已移至 React SplashTitle 头部，TTY 下由 Ink 渲染上色；
    // 非 TTY 文本路径不再内嵌标题，避免与头部重复成两个框）。
    expect(ret[0]).toContain('┌');
    expect(ret[0]).toContain('┐');

    // 底边：纯方角框（与顶边对称；提示文字已移到框外单独一行）
    let bottomIndex = ret.length - 1;
    for (let i = ret.length - 1; i >= 0; i--) {
      const l = ret[i] ?? '';
      if (l.includes('└') || l.includes('┘')) {
        bottomIndex = i;
        break;
      }
    }
    const bottom = ret[bottomIndex];
    expect(bottom).toContain('└');
    expect(bottom).toContain('┘');

    // 提示文字在框外单独居中
    const hintLine = ret[bottomIndex + 1];
    expect(hintLine).toContain('Ctrl+C to abort');

    // 中间每一行都有左右两栏分隔线 │（仅框体内部行）
    const body = ret.slice(1, bottomIndex);
    expect(body.length).toBeGreaterThan(0);
    expect(body.every((l) => l.includes('│'))).toBe(true);

    // 左栏运行信息 + 右栏能力速览
    const all = ret.join('\n');
    expect(all).toContain('Capabilities');
    expect(all).toContain('ReAct loop + Tool Calling');
    expect(all).toContain('Multi-Agent collaboration');
  });

  it('框宽不超出终端：超窄收缩到 cols、超宽 clamp 到 90（不再因 +2 越界换行）', () => {
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

    // 顶边去掉前导居中空格后的可视宽度 = 整框外宽，须 ≤ 终端列数且不溢出。
    const topVisible = (l: string | undefined) => visibleLen((l ?? '').replace(/^\s+/, ''));
    expect(topVisible(narrow[0])).toBeLessThanOrEqual(40); // 窄终端：框收缩到 cols
    expect(topVisible(wide[0])).toBe(90); //                   宽终端：clamp 到 90
  });
});
