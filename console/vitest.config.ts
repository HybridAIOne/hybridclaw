import { defineConfig } from 'vitest/config';
import { containerSharedSources } from '../scripts/vite-container-shared-sources';

export default defineConfig({
  plugins: [containerSharedSources()],
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.test.{ts,tsx}', '*.test.ts'],
    setupFiles: ['./vitest.setup.ts'],
  },
});
