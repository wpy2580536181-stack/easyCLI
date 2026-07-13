import { describe, it, expect } from 'vitest';
import { validateArgs } from '../../src/core/tools/schema-validate';

describe('validateArgs（轻量 JSON Schema 校验）', () => {
  it('缺少必填字段报错', () => {
    const r = validateArgs(
      { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      {},
    );
    expect(r.ok).toBe(false);
  });

  it('类型错误报错', () => {
    const r = validateArgs({ type: 'object', properties: { n: { type: 'number' } } }, { n: 'x' });
    expect(r.ok).toBe(false);
  });

  it('合法对象通过', () => {
    const r = validateArgs(
      { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      { path: 'a.txt' },
    );
    expect(r.ok).toBe(true);
  });

  it('未知 schema 关键字 fail-open（不误拒）', () => {
    const r = validateArgs(
      { type: 'object', properties: { x: { $ref: '#/defs/X' } } },
      { x: 123 },
    );
    expect(r.ok).toBe(true);
  });

  it('enum 约束', () => {
    expect(validateArgs({ type: 'string', enum: ['a', 'b'] }, 'c').ok).toBe(false);
    expect(validateArgs({ type: 'string', enum: ['a', 'b'] }, 'a').ok).toBe(true);
  });

  it('数组 items 与必填校验', () => {
    expect(validateArgs({ type: 'array', items: { type: 'string' } }, ['a', 1]).ok).toBe(false);
    expect(validateArgs({ type: 'array', items: { type: 'string' } }, ['a', 'b']).ok).toBe(true);
  });

  it('字符串长度与数值范围', () => {
    expect(validateArgs({ type: 'string', minLength: 2 }, 'a').ok).toBe(false);
    expect(validateArgs({ type: 'string', minLength: 2 }, 'ab').ok).toBe(true);
    expect(validateArgs({ type: 'number', minimum: 0, maximum: 10 }, 11).ok).toBe(false);
    expect(validateArgs({ type: 'number', minimum: 0, maximum: 10 }, 5).ok).toBe(true);
  });

  it('空 schema 直接通过（不校验）', () => {
    expect(validateArgs({}, { whatever: 1 }).ok).toBe(true);
  });
});
