#!/usr/bin/env node

// Writes dist/plugin-sdk.d.ts, the only declarations the package ships, as one
// self-contained file. tsc emits per-module declarations for src/ and for
// @hybridclaw/shared into a cache dir, and rollup-plugin-dts inlines everything
// the SDK reaches: the shared workspace package is private, so a plugin's type
// check could not resolve an import of it.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
// rollup is pinned at 4.62.3 (agent call, 2026-11-09): 4.62.4 through 4.67.x
// publish the build-only @napi-rs/lzma-linux-x64-gnu optional dependency
// (removed in 4.68.0, rollup#6627); move to 4.68+ once it passes the 7-day
// release-age gate.
import { rollup } from 'rollup';
import { dts } from 'rollup-plugin-dts';

// Not under node_modules, whose files rollup-plugin-dts leaves external.
const declarationsDir = 'dist/.declarations';
const sharedDeclarationsDir = path.resolve(declarationsDir, '.shared');

fs.rmSync(declarationsDir, { recursive: true, force: true });
const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
for (const args of [
  ['--outDir', declarationsDir],
  [
    '-p',
    'packages/shared',
    '--noEmit',
    'false',
    '--declaration',
    '--emitDeclarationOnly',
    '--outDir',
    sharedDeclarationsDir,
  ],
]) {
  const emitted = spawnSync(process.execPath, [tsc, ...args], {
    stdio: 'inherit',
  });
  if (emitted.status !== 0) process.exit(emitted.status ?? 1);
}

// rollup-plugin-dts cannot read the package's .ts sources directly, so its
// imports resolve to the declarations emitted above.
const sharedDeclarations = {
  name: 'shared-declarations',
  resolveId(source) {
    const match = /^@hybridclaw\/shared\/(.+)$/.exec(source);
    return match ? path.join(sharedDeclarationsDir, `${match[1]}.d.ts`) : null;
  },
};

const bundle = await rollup({
  input: `${declarationsDir}/plugin-sdk.d.ts`,
  plugins: [sharedDeclarations, dts({ tsconfig: 'tsconfig.json' })],
  onwarn(warning) {
    // npm packages and node: builtins stay imports, as in the JS bundle.
    if (
      warning.code === 'UNRESOLVED_IMPORT' &&
      !warning.exporter.startsWith('.')
    )
      return;
    throw new Error(warning.message);
  },
});
await bundle.write({ file: 'dist/plugin-sdk.d.ts', format: 'es' });
await bundle.close();
fs.rmSync(declarationsDir, { recursive: true, force: true });
