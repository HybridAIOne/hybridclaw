import { defineConfig } from 'vitest/config';

/**
 * Shared test settings inherited by every project. Coverage lives at the
 * top-level config because it cannot be set per-project in projects mode.
 */
const sharedTestConfig = {
  testTimeout: 15_000,
  env: {
    HYBRIDCLAW_DISABLE_CONFIG_WATCHER: '1',
  },
};

const sharedExclude = ['node_modules/**', 'dist/**', 'container/**'];

export default defineConfig({
  test: {
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
    projects: [
      {
        test: {
          ...sharedTestConfig,
          name: 'unit',
          include: ['tests/**/*.test.ts'],
          exclude: [
            'tests/**/*.integration.test.ts',
            'tests/**/*.e2e.test.ts',
            'tests/**/*.live.test.ts',
            ...sharedExclude,
          ],
        },
      },
      {
        test: {
          ...sharedTestConfig,
          name: 'integration',
          include: ['tests/**/*.integration.test.ts'],
          exclude: sharedExclude,
        },
      },
      {
        test: {
          ...sharedTestConfig,
          name: 'e2e',
          include: ['tests/**/*.e2e.test.ts'],
          exclude: sharedExclude,
          globalSetup: ['tests/helpers/e2e-global-setup.ts'],
        },
      },
      {
        test: {
          ...sharedTestConfig,
          name: 'live',
          include: ['tests/**/*.live.test.ts'],
          exclude: sharedExclude,
          maxWorkers: 1,
        },
      },
    ],
  },
});
