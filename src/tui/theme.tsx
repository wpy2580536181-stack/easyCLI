// 全站统一主题层（Phase 2）。
//
// 基于 @inkjs/ui 的 ThemeProvider + extendTheme，把 Badge / Alert / StatusMessage
// 的色板收口到与 src/cli/theme.ts 的 ui.* 一致的语义色：
//   - info    → cyan（品牌主色；@inkjs/ui 默认是 blue，这里对齐 ui.primary）
//   - success → green / error → red / warning → yellow（标准语义色）
// 这样 StatusLine / Approval 改用 @inkjs/ui 组件后，配色与 splash / StatusBar 一致，
// 彻底解决「各组件配色不统一」的问题。
//
// 设计依据：用户 Phase 2 计划（升 Ink 5 + @inkjs/ui 全站主题）。

import type * as React from 'react';
import { ThemeProvider, extendTheme, defaultTheme } from '@inkjs/ui';

// 语义色板（与 src/cli/theme.ts 的 ui.* 对齐）。
const palette: Record<string, string> = {
  info: 'cyan',
  success: 'green',
  error: 'red',
  warning: 'yellow',
};

// 在默认主题上扩展：仅覆盖 Alert / StatusMessage 的 info 用品牌 cyan，
// 其余语义色保持标准。Badge 颜色由调用方按语义传入（见 StatusLine）。
export const appTheme = extendTheme(defaultTheme, {
  components: {
    Alert: {
      styles: {
        container: ({ variant }: { variant: string }) => ({
          flexGrow: 1,
          borderStyle: 'round',
          borderColor: palette[variant] ?? 'blue',
          gap: 1,
          paddingX: 1,
        }),
        icon: ({ variant }: { variant: string }) => ({
          color: palette[variant] ?? 'blue',
        }),
      },
    },
    StatusMessage: {
      styles: {
        icon: ({ variant }: { variant: string }) => ({
          color: palette[variant] ?? 'blue',
        }),
      },
    },
  },
});

export function AppTheme({ children }: { children: React.ReactNode }): React.ReactElement {
  return <ThemeProvider theme={appTheme}>{children}</ThemeProvider>;
}
