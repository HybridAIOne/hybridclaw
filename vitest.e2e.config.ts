import { defineConfig, mergeConfig } from 'vitest/config';
import unitConfig from './vitest.unit.config.ts';

export default mergeConfig(unitConfig, defineConfig({
  test: {
    include: ['tests/**/*.e2e.test.ts'],
    exclude: ['node_modules/**', 'dist/**', 'container/**'],
    globalSetup: ['tests/helpers/e2e-global-setup.ts'],
  },
}));
