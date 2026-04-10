import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 15_000,
    env: {
      HYBRIDCLAW_DISABLE_CONFIG_WATCHER: '1',
    },
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
      reporter: ['text', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: [
        'container/**',
        'src/cli.ts',
        'src/onboarding.ts',
        'src/tui.ts',
        'src/update.ts',
      ],
      thresholds: {
        lines: 28,
        functions: 30,
        branches: 21,
      },
    },
  },
});
