import { defineConfig } from 'vitest/config';
import { sharedTestConfig } from './vitest.unit.config.ts';

export default defineConfig({
  test: {
    ...sharedTestConfig,
    include: ['tests/**/*.live.test.ts'],
    exclude: ['node_modules/**', 'dist/**', 'container/**'],
    maxWorkers: 1,
  },
});
