import chalk from 'chalk';

/**
 * CLI 统一语义配色（Phase 1：补强层级 + 统一框线）。
 *
 * 之前界面里 `chalk.green` / `chalk.blue` 散落各处（AI 输出被强制染绿、输入提示带「你 ›」），
 * 视觉不统一，且 AI 正文在浅色终端下读不清。这里集中定义语义色，所有 UI 引用本模块。
 *
 * 配色层级（由强到弱，避免「处处高亮」导致无重点）：
 *   primary (青)  >  accent (黄)  >  success/danger (状态)  >  value (白)
 *   >  muted (灰)  >  dim (暗灰)  >  border (框线，中性灰)
 *   assistant     : AI 输出正文不强制着色，跟随终端前景色（深浅终端均清晰）。
 *
 * 用法约定：
 *   - 品牌 / 区块标题 / 输入提示符         → primary
 *   - 重点强调、子弹点、警告提示           → accent
 *   - 运行数据值（模型名、路径、成本等）  → value（白）
 *   - 字段标签、次级说明                   → muted
 *   - 最弱信息（版本号、分隔提示）         → dim
 *   - 所有 box-drawing 边框统一            → border（单一来源，便于整体调色）
 */
export const ui = {
  /** 主色：青（品牌 / 区块标题 / 输入提示符） */
  primary: chalk.cyan,
  /** 强调 / 警告：黄（子弹点、重点提示） */
  accent: chalk.yellow,
  /** 数据值：白（模型名、路径、成本等运行信息，确保深浅终端可读） */
  value: chalk.white,
  /** 弱化文字：灰（字段标签、次级说明） */
  muted: chalk.gray,
  /** 最弱信息：暗灰（版本号、分隔提示等） */
  dim: chalk.dim.gray,
  /** 框线统一色（所有 box-drawing ┌─┐│└┘ 边框的唯一来源） */
  border: chalk.gray,
  /** 用户输入提示符（青色箭头，去掉「你」字） */
  prompt: chalk.cyan('❯ '),
  /** 输入框底色：比背景稍亮/稍暗，用于区分输入行（类 Claude Code 的输入框高亮） */
  inputBg: (s: string) => chalk.bgBlackBright(s),
  /** AI 输出正文：不强制颜色，跟随终端默认前景色（深色/浅色终端均清晰） */
  assistant: (s: string): string => s,
  /** 成功（仅点缀用，如保存成功勾选） */
  success: chalk.green,
  /** 错误 */
  danger: chalk.red,
  /** 加粗 */
  bold: chalk.bold,
};
