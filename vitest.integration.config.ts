import { defineConfig } from 'vitest/config';
import { sharedTestConfig } from './vitest.unit.config.ts';

export default defineConfig({
  test: {
    ...sharedTestConfig,
    include: ['tests/**/*.integration.test.ts'],
    exclude: ['node_modules/**', 'dist/**', 'container/**'],
  },
});
