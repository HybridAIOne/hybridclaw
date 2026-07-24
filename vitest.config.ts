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
const whatsappPluginTestGlobs = ['tests/whatsapp*.test.ts'];

// The installer Docker matrix (scripts/install.sh) lives in its own project so a
// plain `vitest run --project e2e` — invoked by several CI jobs — never pulls it
// in. It is gated only on a reachable Docker daemon (no opt-in env var); run it
// explicitly with `--project install-e2e` (see the test:install-e2e script).
// Note the `-e2e` suffix does NOT match the `.e2e.test.ts` glob, so it must be
// excluded from the broad `unit` include explicitly.
const installE2eGlob = 'tests/**/*.install-e2e.test.ts';

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
            installE2eGlob,
            'tests/**/*.live.test.ts',
            ...whatsappPluginTestGlobs,
            ...sharedExclude,
          ],
        },
      },
      {
        test: {
          ...sharedTestConfig,
          name: 'whatsapp-plugin',
          include: whatsappPluginTestGlobs,
          exclude: sharedExclude,
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
          exclude: [installE2eGlob, ...sharedExclude],
          globalSetup: ['tests/helpers/e2e-global-setup.ts'],
        },
      },
      {
        test: {
          ...sharedTestConfig,
          name: 'install-e2e',
          include: [installE2eGlob],
          exclude: sharedExclude,
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
