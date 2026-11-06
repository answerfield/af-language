import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { conditions: ['af-source'] },
  test: { include: ['test/**/*.test.ts'] }
});
