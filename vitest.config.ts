import { defineConfig } from 'vitest/config';

export default defineConfig({
  // store.ts 用 createRequire 在运行时加载 node:sqlite，vite 不会静态解析该模块；
  // 这里再把 node:sqlite 标为 external，双保险。
  ssr: { external: ['node:sqlite'] },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globals: false,
    deps: { external: ['node:sqlite'] },
  },
});
