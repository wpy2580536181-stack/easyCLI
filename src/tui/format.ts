// 纯派生函数（无 React / ink 依赖），供组件与测试共用。

/** 毫秒时长 → mm:ss（对齐旧 StatusBar.duration 口径）。 */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

/** footer 动画的实时秒数（对齐旧 StatusLine 的 elapsed 显示）。 */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, ms / 1000);
  return `${s.toFixed(1)}s`;
}
