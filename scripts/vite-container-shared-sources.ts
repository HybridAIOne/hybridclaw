/**
 * Vite/Vitest resolver that loads `container/shared/*.ts` sources for their
 * `.js` import specifiers. `tsc -b` emits the `.js` next to each source, and
 * Vite would otherwise prefer that build output, which goes stale on the next
 * edit. Imports from anywhere else resolve as usual.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

const SHARED_DIR = fileURLToPath(
  new URL('../container/shared/', import.meta.url),
);

export function containerSharedSources(): Plugin {
  return {
    name: 'container-shared-sources',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!importer || !source.startsWith('.') || !source.endsWith('.js')) {
        return null;
      }
      const file = path.resolve(path.dirname(importer), source);
      if (`${path.dirname(file)}${path.sep}` !== SHARED_DIR) return null;
      return `${file.slice(0, -'.js'.length)}.ts`;
    },
  };
}
