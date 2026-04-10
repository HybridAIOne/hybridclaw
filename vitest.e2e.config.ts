import { defineConfig } from 'vitest/config';
import { sharedTestConfig } from './vitest.unit.config.ts';

export default defineConfig({
  test: {
    ...sharedTestConfig,
    include: ['tests/**/*.e2e.test.ts'],
    exclude: ['node_modules/**', 'dist/**', 'container/**'],
    globalSetup: ['tests/helpers/e2e-global-setup.ts'],
  },
});
