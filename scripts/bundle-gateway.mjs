#!/usr/bin/env node

// Bundles the CLI (and the plugin SDK it links for plugins) from source into
// dist/, the gateway's only runtime JS: the npm package, desktop app, and
// container image all run dist/cli.js; `tsc` emits only the declarations beside
// it. Startup otherwise resolves and reads about a thousand separate modules,
// and under a syscall-intercepting sandbox runtime such as gVisor each lookup is
// slow enough to cost seconds per boot.
//
// The output sits one level below the package root, so code that locates
// package files relative to its own module keeps working.

import fs from 'node:fs';
import { build } from 'esbuild';

// Pure-JS dependencies loaded during gateway startup. All other dependencies
// stay external: native addons, packages that resolve their own files at
// runtime (pino transports, browsers), and ones that are only loaded on demand.
const BUNDLED_DEPENDENCIES = new Set([
  'ajv',
  'cron-parser',
  'jose',
  'marked',
  'qrcode-terminal',
  'sanitize-html',
  'undici',
  'ws',
  'yaml',
  'yauzl',
  'yazl',
]);

// Matched on what first-party code imports, not on package.json: src also
// imports transitive packages such as botbuilder-core, and inlining those would
// load a second copy beside the one their external parent package uses.
const externalUnlessBundled = {
  name: 'external-unless-bundled',
  setup(build) {
    build.onResolve({ filter: /^[^./]/ }, (args) => {
      if (/[\\/]node_modules[\\/]/.test(args.importer)) return undefined;
      const [scope, name] = args.path.split('/');
      const pkg = scope.startsWith('@') ? `${scope}/${name}` : scope;
      return BUNDLED_DEPENDENCIES.has(pkg) ? undefined : { external: true };
    });
  },
};

// Chunk names are content hashes, so a rebuild would otherwise leave every
// previous build's chunks beside the new ones. `tsc` runs after this.
fs.rmSync('dist', { recursive: true, force: true });

await build({
  entryPoints: {
    cli: 'src/cli-entry.ts',
    'plugin-sdk': 'src/plugin-sdk.ts',
  },
  outdir: 'dist',
  // Shipped but not enabled (owner call, 2026-10-12): --enable-source-maps
  // added ~130ms to gateway startup; pass it via NODE_OPTIONS when debugging.
  // Without sourcesContent the maps are 6 MB instead of 18 MB.
  sourcemap: true,
  sourcesContent: false,
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  plugins: [externalUnlessBundled],
  // Bundled CommonJS dependencies call require(); ESM output has none.
  banner: {
    js: "import { createRequire as __bundleCreateRequire } from 'node:module';\nconst require = __bundleCreateRequire(import.meta.url);",
  },
  logLevel: 'warning',
});
fs.chmodSync('dist/cli.js', 0o755);
