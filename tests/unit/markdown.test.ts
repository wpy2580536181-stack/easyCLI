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
    expect(strip(out[0] ?? '')).toContain('核心目标');
  });

  it('无序列表用 • 且去掉 -, 有序列表用数字', () => {
    const a = renderMarkdown('- 第一项\n- 第二项', 80);
    expect(a.join('\n')).toContain('•');
    expect(a.join('\n')).not.toContain('- ');
    const b = renderMarkdown('1. 第一步\n2. 第二步', 80);
    expect(strip(b[0] ?? '')).toContain('1.');
    expect(strip(b[1] ?? '')).toContain('2.');
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

  it('GFM 表格渲染为对齐的 ASCII 表格（含边框，不残留 |）', () => {
    const src = '| 模块 | 功能 |\n|------|------|\n| agent/ | ReAct 主逻辑 |\n| mcp/ | 客户端/服务端 |';
    const out = renderMarkdown(src, 60);
    const j = out.join('\n');
    expect(j).toContain('┌');
    expect(j).toContain('├');
    expect(j).toContain('└');
    // 表头/分隔/正文至少 3 行 + 上下边框
    expect(out.length).toBeGreaterThanOrEqual(5);
    // 原始管道符应被拆成单元格，不应再出现裸 | 作为分隔残留
    expect(j).not.toMatch(/\| 模块 \| 功能 \|/);
  });

  it('表格支持对齐语法（:--- / :---: / ---:）', () => {
    const src = '| 左 | 中 | 右 |\n|:--|:-:|--:|\n| a | b | c |';
    const out = renderMarkdown(src, 40);
    // 至少能正常渲染出表格（不报错、有边框）
    expect(out.join('\n')).toContain('┌');
    expect(out.length).toBeGreaterThanOrEqual(5);
  });

  it('窄终端下表格自动等比缩小内容区，不超出可用宽度', () => {
    const src = '| 模块 | 功能说明 |\n|------|----------|\n| agent/ | ReAct 循环、Agent 主逻辑与工具调度 |\n| memory/ | 上下文压缩与长期记忆存储 |';
    const out = renderMarkdown(src, 50);
    for (const ln of out) {
      expect(dispWidth(ln)).toBeLessThanOrEqual(50);
    }
    expect(out.join('\n')).toContain('┌');
  });

  it('任务列表渲染 ☑/☐ 并去掉 [ ] 标记', () => {
    const out = renderMarkdown('- [x] 已完成\n- [ ] 待办', 60);
    const j = out.join('\n');
    expect(j).toContain('☑');
    expect(j).toContain('☐');
    expect(j).not.toContain('[x]');
    expect(j).not.toContain('[ ]');
  });

  it('转义字符显示字面量，不触发样式', () => {
    const out = renderMarkdown('字面星号 \\*不是斜体\\*，反斜杠 \\\\ 在', 60);
    const j = out.join('\n');
    // 转义后 * 当作字面量保留，不应被渲染成斜体（即不应有斜体 ANSI 码）
    expect(j).toContain('*不是斜体*');
    expect(j).toContain('\\');
    expect(j).not.toContain('\x1b[3m'); // 无 italic 样式码
  });

  it('裸 URL 自动链接（青色下划线），不残留 http 明文冗余', () => {
    const out = renderMarkdown('详见 https://example.com 站点', 60);
    const j = out.join('\n');
    expect(j).toContain('https://example.com');
    expect(j).toContain('详见');
  });

  it('图片语法退化为 alt 文本', () => {
    const out = renderMarkdown('![架构图](https://img.x.com/a.png) 如上', 60);
    const j = out.join('\n');
    expect(j).toContain('架构图');
    expect(j).not.toContain('https://img.x.com/a.png');
  });

  it('表格不应被误判为普通段落（不出现空格拼接的乱行）', () => {
    const src = '## 模块\n| 模块 | 功能 |\n|------|------|\n| agent/ | ReAct |\n| mcp/ | 协议 |';
    const out = renderMarkdown(src, 60);
    const j = out.join('\n');
    // 表头与正文行不应被合并成一行用空格拼接
    expect(j).not.toContain('| 模块 | 功能 | |------|------|');
  });
});
