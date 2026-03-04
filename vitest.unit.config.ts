import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: [
      'tests/**/*.integration.test.ts',
      'tests/**/*.e2e.test.ts',
      'tests/**/*.live.test.ts',
      'node_modules/**',
      'dist/**',
      'container/**',
    ],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      thresholds: {
        lines: 30,
        functions: 30,
        branches: 25,
      },
    },
  },
});
