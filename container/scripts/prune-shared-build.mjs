#!/usr/bin/env node
/**
 * Removes stale `tsc -b` output from `container/shared/` before it is built.
 *
 * The output sits next to each `.ts` source, and tsc never deletes the output
 * of a removed source, so an orphaned `.js`/`.d.ts` would keep satisfying
 * imports locally and ship. `tsc -b` judges freshness from the tsbuildinfo
 * alone, so a missing output only gets rebuilt once that file is gone.
 * Compiles nothing itself; callers run `tsc -b` next.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sharedDir = fileURLToPath(new URL('../shared/', import.meta.url));
const entries = new Set(fs.readdirSync(sharedDir));
const sources = new Set(
  [...entries]
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.d.ts'))
    .map((name) => name.slice(0, -'.ts'.length)),
);

for (const name of entries) {
  const stem = name.endsWith('.d.ts')
    ? name.slice(0, -'.d.ts'.length)
    : name.endsWith('.js')
      ? name.slice(0, -'.js'.length)
      : null;
  if (stem !== null && !sources.has(stem)) {
    fs.rmSync(path.join(sharedDir, name));
  }
}

const outputMissing = [...sources].some(
  (stem) => !entries.has(`${stem}.js`) || !entries.has(`${stem}.d.ts`),
);
if (outputMissing) {
  fs.rmSync(path.join(sharedDir, 'tsconfig.tsbuildinfo'), { force: true });
}
