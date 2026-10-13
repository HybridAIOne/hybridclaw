#!/usr/bin/env node

// Bundles the agent runtime from source into dist/index.js, the only JS the
// agent image, host sandbox, and hybridclaw-agent package run; `tsc` only type-
// checks. Shared modules are inlined; every npm package, declared or only
// transitive, stays external and loads from node_modules next to dist/.

import { build } from 'esbuild';

await build({
  entryPoints: { index: 'src/index.ts' },
  outdir: 'dist',
  // Same maps tsc shipped (no sourcesContent); NODE_OPTIONS=--enable-source-maps
  // turns them on.
  sourcemap: true,
  sourcesContent: false,
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  packages: 'external',
  logLevel: 'warning',
});
