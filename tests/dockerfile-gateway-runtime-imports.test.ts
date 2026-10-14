import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';

// The gateway's dist/ is plain tsc output: it keeps every relative import as
// written, so a directory src/ reaches outside itself has to be in the image
// or the gateway dies on its first require with ERR_MODULE_NOT_FOUND. The
// agent bundle inlining container/shared does not cover this — that bundle is
// container/dist, a different entry point. Removing the copy has broken the
// image twice (f5da5e8f9, then again in 18048ea0d), both times only visible
// once a sandbox was started, so this is asserted from the source rather than
// left to a smoke test.
const repoRoot = path.resolve(import.meta.dirname, '..');

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf-8');
}

function runtimeStage(): string {
  const dockerfile = readRepoFile('Dockerfile');
  return dockerfile.slice(dockerfile.indexOf(' AS runtime'));
}

/** Top-level directories outside src/ that src/ imports at runtime. */
function siblingDirsImportedBySrc(): string[] {
  const found = new Set<string>();
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.d.ts')) continue;
      const source = fs.readFileSync(full, 'utf-8');
      // Only value imports matter: a type-only import is erased by tsc and
      // needs nothing in the image.
      for (const match of source.matchAll(
        /^(?:import|export)\s+(?!type\s)[^;]*?from\s+'((?:\.\.\/)+[^']+)'/gm,
      )) {
        const resolved = path.relative(
          repoRoot,
          path.resolve(path.dirname(full), match[1]),
        );
        if (resolved.startsWith('..') || resolved.startsWith('src/')) continue;
        found.add(resolved.split(path.sep)[0] + '/' + resolved.split(path.sep)[1]);
      }
    }
  };
  walk(path.join(repoRoot, 'src'));
  return [...found].sort();
}

test('the runtime stage ships every directory the gateway imports at runtime', () => {
  const runtime = runtimeStage();
  const missing = siblingDirsImportedBySrc().filter(
    (dir) => !runtime.includes(`/app/${dir} ./${dir}`),
  );
  expect(missing).toEqual([]);
});

test('container/shared is in the image, because the gateway loads it by path', () => {
  expect(runtimeStage()).toContain(
    'COPY --link --from=builder /app/container/shared ./container/shared',
  );
  // The import that took the image down: runtime-config is on the gateway's
  // startup path, so a missing container/shared is a crash, not a degradation.
  expect(readRepoFile('src/config/runtime-config.ts')).toContain(
    "from '../../container/shared/context-guard-config.js'",
  );
});
