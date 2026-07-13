// Ambient module declaration for @inkjs/ui.
//
// The published package (2.0.0) ships only compiled .js under build/ and no
// .d.ts files (its package.json `types` points at a non-existent build/index.d.ts),
// so we declare the subset of the API this project actually uses.
declare module '@inkjs/ui' {
  import type * as React from 'react';

  export const defaultTheme: { components: Record<string, unknown> };
  export function extendTheme(base: unknown, override: unknown): unknown;
  export const ThemeProvider: React.FC<{ theme: unknown; children?: React.ReactNode }>;

  export interface BadgeProps {
    color?: string;
    children?: React.ReactNode;
  }
  export const Badge: React.FC<BadgeProps>;

  export type AlertVariant = 'success' | 'error' | 'warning' | 'info';
  export interface AlertProps {
    variant: AlertVariant;
    title?: string;
    children?: React.ReactNode;
  }
  export const Alert: React.FC<AlertProps>;

  export interface StatusMessageProps {
    variant: AlertVariant;
    children?: React.ReactNode;
  }
  export const StatusMessage: React.FC<StatusMessageProps>;
}
