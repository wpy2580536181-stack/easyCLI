import { describe, it, expect } from 'vitest';
import { parseUnifiedDiff, diffStats, toSplitPairs } from '../../src/tui/diff';

const SAMPLE = `diff --git a/src/auth/login.ts b/src/auth/login.ts
--- a/src/auth/login.ts
+++ b/src/auth/login.ts
@@ -10,4 +10,4 @@
 import { sess } from './old'
-const sess = req.cookies.sid
+const tok = req.headers.authorization
 if (!validate(tok)) return 401`;

describe('parseUnifiedDiff', () => {
  it('识别 file / hunk / add / del 标记', () => {
    // 用独立 del/add（不相邻，避免被合并成 mod）验证四种基本标记。
    // 注：相邻 del→add 会被合并为 mod（见下方测试），故此处刻意隔开。
    const patch = [
      'diff --git a/demo.ts b/demo.ts',
      '--- a/demo.ts',
      '+++ b/demo.ts',
      '@@ -1,3 +1,4 @@',
      ' context line',
      '-removed line',
      ' context between',
      '+added line',
    ].join('\n');
    const lines = parseUnifiedDiff(patch);
    expect(lines.some((l) => l.kind === 'file')).toBe(true);
    expect(lines.some((l) => l.kind === 'hunk')).toBe(true);
    const add = lines.find((l) => l.kind === 'add');
    expect(add?.text).toBe('added line');
    const del = lines.find((l) => l.kind === 'del');
    expect(del?.text).toBe('removed line');
  });

  it('相邻 del→add 合并为一条 mod（文本取新版本，oldText 存旧版本）', () => {
    const lines = parseUnifiedDiff(SAMPLE);
    const mod = lines.find((l) => l.kind === 'mod');
    expect(mod).toBeTruthy();
    expect(mod?.oldText).toContain('cookies.sid');
    expect(mod?.text).toContain('headers.authorization');
  });

  it('蓝图自定义 ~ 标记解析为 mod', () => {
    const lines = parseUnifiedDiff('  some ctx\n~ return next()');
    expect(lines[1].kind).toBe('mod');
    expect(lines[1].text).toBe(' return next()');
  });
});

describe('diffStats', () => {
  it('合并对不重复计数（1 del+1 add → 0/0/1）', () => {
    const s = diffStats(parseUnifiedDiff(SAMPLE));
    expect(s.add).toBe(0);
    expect(s.del).toBe(0);
    expect(s.mod).toBe(1);
  });
});

describe('toSplitPairs', () => {
  it('del+add 配对到同一行（左旧右新）', () => {
    const pairs = toSplitPairs(parseUnifiedDiff(SAMPLE));
    const pair = pairs.find((p) => p.oldLine && p.newLine && !p.isCtx);
    expect(pair).toBeTruthy();
    expect(pair?.oldLine?.text).toContain('cookies.sid');
    expect(pair?.newLine?.text).toContain('headers.authorization');
  });

  it('上下文行两侧同行', () => {
    const pairs = toSplitPairs(parseUnifiedDiff(SAMPLE));
    const ctx = pairs.find((p) => p.isCtx && p.newLine?.text?.includes('validate'));
    expect(ctx).toBeTruthy();
    expect(ctx?.oldLine?.text).toContain('validate');
  });
});
