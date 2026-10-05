#!/usr/bin/env node

// Bundles the compiled CLI (and the plugin SDK it links for plugins) into
// bundle/ for the container image. Startup otherwise resolves and reads about
// a thousand separate modules, and under a syscall-intercepting sandbox
// runtime such as gVisor each lookup is slow enough to cost seconds per boot.
//
// The output sits one level below the package root, like dist/cli.js, so code
// that locates package files relative to its own module keeps working.

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

const { dependencies } = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const external = Object.keys(dependencies)
  .filter((name) => !BUNDLED_DEPENDENCIES.has(name))
  .flatMap((name) => [name, `${name}/*`]);

await build({
  entryPoints: {
    cli: 'dist/cli.js',
    'plugin-sdk': 'dist/plugins/plugin-sdk.js',
  },
  outdir: 'bundle',
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  external,
  // Bundled CommonJS dependencies call require(); ESM output has none.
  banner: {
    js: "import { createRequire as __bundleCreateRequire } from 'node:module';\nconst require = __bundleCreateRequire(import.meta.url);",
  },
  logLevel: 'warning',
});
