import { defineConfig, mergeConfig } from 'vitest/config';
import unitConfig from './vitest.unit.config.ts';

export default mergeConfig(unitConfig, defineConfig({
  test: {
    include: ['tests/**/*.integration.test.ts'],
    exclude: ['node_modules/**', 'dist/**', 'container/**'],
  },
}));
