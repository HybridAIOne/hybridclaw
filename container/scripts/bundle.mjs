#!/usr/bin/env node

// Bundles the agent runtime from source into dist/index.js, the only JS the
// agent image, host sandbox, and hybridclaw-agent package run; `tsc` only type-
// checks. The first-party @hybridclaw/* workspace packages are inlined; every
// npm package, declared or only transitive, stays external and loads from
// node_modules next to dist/.

import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const externalExceptWorkspace = {
  name: 'external-except-workspace',
  setup(build) {
    build.onResolve({ filter: /^[^./]/ }, (args) =>
      /^@hybridclaw\/(contracts|shared)\//.test(args.path)
        ? undefined
        : { external: true },
    );
  },
};

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
  plugins: [externalExceptWorkspace],
  // The workspace packages are linked from outside this package (../packages,
  // or /packages in the image build), so their own @hybridclaw imports resolve
  // through this package's node_modules.
  nodePaths: [fileURLToPath(new URL('../node_modules', import.meta.url))],
  logLevel: 'warning',
});
