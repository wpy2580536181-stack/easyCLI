// TUI 设计令牌（Design Tokens）—— 与 design/easyCLI-界面设计方案 配色完全一致的唯一来源。
//
// 终端为深色主题（设计稿背景 #161320），故文本用浅色、强调用品牌青/洋红。
// 这是 Ink 可消费的 hex 字符串版本（对应 src/cli/theme.ts 的 `ui.*` chalk 令牌）；
// TUI 组件一律引用本模块，避免各处散落 `color="cyan"` 导致「配色不统一」。
//
// 设计依据：design/easyCLI-界面设计方案 · 色彩卡（primary #22D3EE / brand #EC4FD0 /
// success #22C55E / error #F4586E / warning #F5A623 / 主文本 #ECE7F4 / 次文本 #938BA6）。

export const TOKENS = {
  /** 品牌青（主色）：提示符、标题、模型名、info、链接/代码 */
  primary: '#22D3EE',
  /** 品牌洋红（高亮 / edit·权限语义 / 渐变中段） */
  brand: '#EC4FD0',
  /** 成功 / 完成 */
  success: '#22C55E',
  /** 错误 / 失败 */
  error: '#F4586E',
  /** 警告 / 强调（琥珀，区别于品牌洋红） */
  warning: '#F5A623',
  /** 主文本（强） */
  text: '#ECE7F4',
  /** 次文本 / 弱化（字段标签、说明、分割线、占位） */
  subtext: '#938BA6',
} as const;

export type TokenColor = (typeof TOKENS)[keyof typeof TOKENS];
