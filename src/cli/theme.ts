import chalk from 'chalk';

/**
 * CLI 统一语义配色。
 *
 * 之前界面里 `chalk.green` / `chalk.blue` 散落各处（AI 输出被强制染绿、输入提示带「你 ›」），
 * 视觉不统一，且 AI 正文在浅色终端下读不清。这里集中定义语义色，所有 UI 引用本模块：
 *   - primary   : 品牌 / 模型名 / 输入提示符（青）
 *   - muted     : 标签、提示、分隔线等弱化文字（灰）
 *   - accent    : 警告 / 用法提示（黄）
 *   - assistant : AI 输出正文（不强制着色，跟随终端前景色，深浅终端都可读）
 *   - success   : 仅用于成功勾选 / 保存等点缀，不用于大段正文（绿）
 *   - danger    : 错误（红）
 */
export const ui = {
  /** 主色：青 */
  primary: chalk.cyan,
  /** 弱化文字：灰 */
  muted: chalk.gray,
  /** 强调 / 警告：黄 */
  accent: chalk.yellow,
  /** 用户输入提示符（青色箭头，去掉「你」字） */
  prompt: chalk.cyan('❯ '),
  /** AI 输出正文：不强制颜色，跟随终端默认前景色（深色/浅色终端均清晰） */
  assistant: (s: string): string => s,
  /** 成功（仅点缀用，如保存成功勾选） */
  success: chalk.green,
  /** 错误 */
  danger: chalk.red,
  /** 加粗 */
  bold: chalk.bold,
};
