import { describe, it, expect } from 'vitest';
import { renderMarkdown } from '../../src/cli/markdown';

/** 计算显示宽度（CJK/全角按 2），与渲染器内部一致 */
function dispWidth(s: string): number {
  const strip = s.replace(/\x1b\[[0-9;]*m/g, '');
  let w = 0;
  for (const ch of strip) {
    const code = ch.codePointAt(0) ?? 0;
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0x303e) ||
      (code >= 0x3041 && code <= 0x33ff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x20000 && code <= 0x3fffd);
    w += wide ? 2 : 1;
  }
  return w;
}

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

describe('renderMarkdown', () => {
  it('消费粗体标记，不残留 **', () => {
    const out = renderMarkdown('这是 **粗体** 文本', 80);
    expect(out.join('\n')).not.toContain('**');
    expect(out).toHaveLength(1);
  });

  it('标题去掉 # 井号', () => {
    const out = renderMarkdown('### 核心目标', 80);
    expect(out.join('\n')).not.toContain('#');
    expect(strip(out[0])).toContain('核心目标');
  });

  it('无序列表用 • 且去掉 -, 有序列表用数字', () => {
    const a = renderMarkdown('- 第一项\n- 第二项', 80);
    expect(a.join('\n')).toContain('•');
    expect(a.join('\n')).not.toContain('- ');
    const b = renderMarkdown('1. 第一步\n2. 第二步', 80);
    expect(strip(b[0])).toContain('1.');
    expect(strip(b[1])).toContain('2.');
  });

  it('代码块渲染 λ 语言头，且不残留 ```', () => {
    const out = renderMarkdown('```ts\nconst x = 1;\n```', 80);
    expect(out.join('\n')).not.toContain('```');
    expect(out.join('\n')).toContain('λ ts');
  });

  it('链接只显示文字，不显示 [ ] ( ) 原始语法', () => {
    const out = renderMarkdown('[主页](https://e.com)', 80);
    const j = out.join('\n');
    expect(j).toContain('主页');
    expect(j).not.toContain('[主页]');
    expect(j).not.toContain('(https://e.com)');
  });

  it('引用产生 │ 前缀', () => {
    const out = renderMarkdown('> 引用内容', 80);
    expect(out.join('\n')).toContain('│');
  });

  it('超长单词按宽度硬断，且任何行显示宽度不超过宽度', () => {
    const long = 'a'.repeat(100);
    const out = renderMarkdown(long, 20);
    for (const ln of out) {
      expect(dispWidth(ln)).toBeLessThanOrEqual(20);
    }
    // 至少断成多行
    expect(out.length).toBeGreaterThan(1);
  });

  it('长中文段落按显示宽度折行且不超宽（CJK 按 2 列）', () => {
    const para = '中文'.repeat(60); // 120 个半角宽
    const out = renderMarkdown(para, 40);
    for (const ln of out) {
      expect(dispWidth(ln)).toBeLessThanOrEqual(40);
    }
  });

  it('跨行粗体也能被正确消费（不残留 **）', () => {
    // 一个会被折成多行的超长粗体段落
    const src = '**' + '这是一段非常长用来测试粗体跨行时是否还会残留星号的文本内容'.repeat(3) + '**';
    const out = renderMarkdown(src, 40);
    expect(out.join('\n')).not.toContain('**');
  });
});
