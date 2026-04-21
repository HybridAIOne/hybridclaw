import { defineConfig } from 'vitest/config';

/** Shared test settings inherited by e2e, integration, and live configs. */
export const sharedTestConfig = {
  testTimeout: 15_000,
  env: {
    HYBRIDCLAW_DISABLE_CONFIG_WATCHER: '1',
  },
  coverage: {
    provider: 'v8' as const,
    reporter: ['text', 'json-summary'] as const,
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
};

export default defineConfig({
  test: {
    ...sharedTestConfig,
    include: ['tests/**/*.test.ts'],
    exclude: [
      'tests/**/*.integration.test.ts',
      'tests/**/*.e2e.test.ts',
      'tests/**/*.live.test.ts',
      'node_modules/**',
      'dist/**',
      'container/**',
    ],
  },
});
