import { defineConfig } from 'vitest/config';
import { containerSharedAlias } from '../scripts/container-shared-alias';

export default defineConfig({
  resolve: { alias: containerSharedAlias },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.test.{ts,tsx}', '*.test.ts'],
    setupFiles: ['./vitest.setup.ts'],
  },
});
