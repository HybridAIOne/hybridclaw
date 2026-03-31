import { defineConfig } from 'vitest/config';
import unitConfig from './vitest.unit.config.js';

const base = unitConfig as unknown as Record<string, unknown>;
const baseTest = (unitConfig as { test?: { exclude?: string[] } }).test ?? {};
const exclude = (baseTest.exclude ?? []).filter(
  (entry) => entry !== 'tests/**/*.e2e.test.ts',
);

export default defineConfig({
  ...base,
  test: {
    ...baseTest,
    include: ['tests/**/*.e2e.test.ts'],
    exclude,
    globalSetup: ['tests/helpers/e2e-global-setup.ts'],
  },
});
