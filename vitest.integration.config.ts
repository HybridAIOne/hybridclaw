import { defineConfig } from 'vitest/config';
import unitConfig from './vitest.unit.config.js';

const base = unitConfig as unknown as Record<string, unknown>;
const baseTest = (unitConfig as { test?: { exclude?: string[] } }).test ?? {};
const exclude = (baseTest.exclude ?? []).filter((entry) => entry !== 'tests/**/*.integration.test.ts');

export default defineConfig({
  ...base,
  test: {
    ...baseTest,
    include: ['tests/**/*.integration.test.ts'],
    exclude,
  },
});
