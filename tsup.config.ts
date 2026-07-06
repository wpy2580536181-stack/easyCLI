import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    'cli/main': 'src/cli/main.ts',
  },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  clean: true,
  sourcemap: true,
  // 保留源码里的 shebang（#!/usr/bin/env node）
  banner: { js: '' },
  // 将依赖留在 node_modules，CLI 运行时 require
  noExternal: [],
  shims: true,
});
