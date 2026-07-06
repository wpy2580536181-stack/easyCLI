import { resolve, sep } from 'node:path';

/**
 * 路径围栏（硬 gate，不可关闭）：把相对/绝对路径解析到项目根目录内，
 * 任何试图逃出 root 的访问一律抛错拦截。文件类工具统一调用。
 */
export function resolveSafe(root: string, p: string): string {
  const abs = resolve(root, p);
  const normalizedRoot = resolve(root);
  if (abs !== normalizedRoot && !abs.startsWith(normalizedRoot + sep)) {
    throw new Error(`路径超出项目根目录被拦截: ${p}`);
  }
  return abs;
}
