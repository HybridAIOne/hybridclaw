/**
 * Vite/Vitest alias that loads `container/shared/src/*.ts` for `#shared/*.js`
 * imports. Node resolves `#shared/*` through the package.json `imports` map to
 * the compiled `container/shared/dist/`; tests and the console bundle read the
 * sources instead, so they never need, or see, a stale build. The second entry
 * covers infra/managed-browser, which sits outside both package scopes and
 * imports the dist path directly.
 */
import { fileURLToPath } from 'node:url';

const SHARED_SRC = fileURLToPath(
  new URL('../container/shared/src/', import.meta.url),
);

export const containerSharedAlias = [
  { find: /^#shared\/(.+)\.js$/, replacement: `${SHARED_SRC}$1.ts` },
  {
    find: /^(?:\.\.\/)+container\/shared\/dist\/(.+)\.js$/,
    replacement: `${SHARED_SRC}$1.ts`,
  },
];
