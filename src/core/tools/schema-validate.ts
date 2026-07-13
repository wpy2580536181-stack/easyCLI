// 工具入参的运行时校验（差异3 / PaiCLI「zod 运行时校验」对齐项）。
//
// 设计取舍：
// - 文章建议「用 zod-to-json-schema 反向把 JSON Schema 转 zod 校验」。但本仓库工具定义统一用
//   JSON Schema（inputSchema，与 OpenAI function calling 对齐），而 zod-to-json-schema 只做
//   zod→JSON 单向，反向需要 json-schema-to-zod（未引入）。因此这里写一个**轻量 JSON Schema
//   校验器**，零新增依赖、与现有 inputSchema 形态直接对接。
// - 关键原则：**失败开放（fail-open）**。遇到不认识的 schema 关键字（如 $defs / allOf）直接跳过，
//   绝不因此误拒合法调用；只对我们理解的基础约束（type/required/properties/enum/length/range/items）
//   做强制，从而在不引入重依赖的前提下显著提升健壮性，又不引入回归风险。
//
// 典型收益：LLM 偶发畸形工具参数（缺必填字段 / 类型错）在入口即被拦下返回 ok:false，
// 不再「跑一半才在某行抛类型错」浪费一次工具调用。

export type ValidationResult = { ok: true } | { ok: false; error: string };

function ok(): ValidationResult {
  return { ok: true };
}
function fail(path: string, msg: string): ValidationResult {
  return { ok: false, error: path ? `${path}: ${msg}` : msg };
}

/** JSON Schema 基础类型与 JS 值的匹配（未知 type 关键字 → 视为匹配，保持 fail-open）。 */
function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && !Number.isNaN(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'null':
      return value === null;
    default:
      return true; // 不认识的类型约束 → 跳过，不误拒
  }
}

/**
 * 递归校验一个值是否符合给定的 JSON Schema（子集）。
 * @param schema 工具的 inputSchema（JSON Schema 对象）
 * @param value 模型实际给出的参数对象
 * @param path 当前路径（用于错误信息定位，顶级为空串）
 */
export function validateArgs(
  schema: Record<string, unknown>,
  value: unknown,
  path = '',
): ValidationResult {
  if (!schema || typeof schema !== 'object') return ok();

  // enum：显式枚举值约束
  if (Array.isArray((schema as any).enum) && !(schema as any).enum.includes(value)) {
    return fail(path, `应为枚举值之一: ${JSON.stringify((schema as any).enum)}`);
  }

  const type = (schema as any).type;
  if (type !== undefined) {
    const types = Array.isArray(type) ? type : [type];
    if (!types.some((t: string) => matchesType(t, value))) {
      return fail(path, `类型应为 ${types.join('|')}，实际为 ${value === null ? 'null' : typeof value}`);
    }
  }

  // 对象：校验必填字段与 properties 子结构
  if (type === 'object' || (Array.isArray(type) && type.includes('object'))) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const obj = value as Record<string, unknown>;
      const props = ((schema as any).properties ?? {}) as Record<string, unknown>;
      const required = ((schema as any).required ?? []) as unknown[];
      for (const r of required) {
        const key = String(r);
        if (!(key in obj)) return fail(path, `缺少必填字段 "${key}"`);
      }
      for (const [k, v] of Object.entries(obj)) {
        if (k in props) {
          const sub = validateArgs(props[k] as Record<string, unknown>, v, path ? `${path}.${k}` : k);
          if (!sub.ok) return sub;
        } else if ((schema as any).additionalProperties === false) {
          return fail(path, `不允许额外字段 "${k}"`);
        }
      }
    }
  }

  // 数组：长度与元素约束
  if (type === 'array' || (Array.isArray(type) && type.includes('array'))) {
    if (Array.isArray(value)) {
      const minItems = (schema as any).minItems;
      const maxItems = (schema as any).maxItems;
      if (typeof minItems === 'number' && value.length < minItems) {
        return fail(path, `至少需 ${minItems} 项，实际 ${value.length}`);
      }
      if (typeof maxItems === 'number' && value.length > maxItems) {
        return fail(path, `至多 ${maxItems} 项，实际 ${value.length}`);
      }
      const items = (schema as any).items;
      if (items) {
        for (let i = 0; i < value.length; i++) {
          const sub = validateArgs(items as Record<string, unknown>, value[i], `${path}[${i}]`);
          if (!sub.ok) return sub;
        }
      }
    }
  }

  // 字符串长度
  if (typeof value === 'string') {
    const minLen = (schema as any).minLength;
    const maxLen = (schema as any).maxLength;
    if (typeof minLen === 'number' && value.length < minLen) {
      return fail(path, `长度至少 ${minLen}，实际 ${value.length}`);
    }
    if (typeof maxLen === 'number' && value.length > maxLen) {
      return fail(path, `长度至多 ${maxLen}，实际 ${value.length}`);
    }
  }

  // 数值范围
  if (typeof value === 'number') {
    const min = (schema as any).minimum;
    const max = (schema as any).maximum;
    if (typeof min === 'number' && value < min) return fail(path, `不小于 ${min}`);
    if (typeof max === 'number' && value > max) return fail(path, `不大于 ${max}`);
  }

  return ok();
}
