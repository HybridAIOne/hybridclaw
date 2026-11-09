#!/usr/bin/env node

// Writes dist/plugin-sdk.d.ts, the only declarations the package ships, as one
// self-contained file. tsc emits per-module declarations for src/ and for each
// workspace package into a cache dir, and rollup-plugin-dts inlines everything
// the SDK reaches: the workspace packages are private, so a plugin's type check
// could not resolve an import of them.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { rollup } from 'rollup';
import { dts } from 'rollup-plugin-dts';

// Not under node_modules, whose files rollup-plugin-dts leaves external.
const declarationsDir = 'dist/.declarations';
const WORKSPACE_PACKAGES = ['contracts', 'shared'];
const packageDeclarationsDir = (name) =>
  path.resolve(declarationsDir, '.packages', name);

fs.rmSync(declarationsDir, { recursive: true, force: true });
const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
for (const args of [
  ['--outDir', declarationsDir],
  ...WORKSPACE_PACKAGES.map((name) => [
    '-p',
    `packages/${name}`,
    '--noEmit',
    'false',
    '--declaration',
    '--emitDeclarationOnly',
    '--outDir',
    packageDeclarationsDir(name),
  ]),
]) {
  const emitted = spawnSync(process.execPath, [tsc, ...args], {
    stdio: 'inherit',
  });
  if (emitted.status !== 0) process.exit(emitted.status ?? 1);
}

// rollup-plugin-dts cannot read the packages' .ts sources directly, so their
// imports resolve to the declarations emitted above.
const workspaceDeclarations = {
  name: 'workspace-declarations',
  resolveId(source) {
    const match = /^@hybridclaw\/([^/]+)\/(.+)$/.exec(source);
    if (!match || !WORKSPACE_PACKAGES.includes(match[1])) return null;
    return path.join(packageDeclarationsDir(match[1]), `${match[2]}.d.ts`);
  },
};

const bundle = await rollup({
  input: `${declarationsDir}/plugin-sdk.d.ts`,
  plugins: [workspaceDeclarations, dts({ tsconfig: 'tsconfig.json' })],
  onwarn(warning) {
    // npm packages and node: builtins stay imports, as in the JS bundle.
    if (
      warning.code === 'UNRESOLVED_IMPORT' &&
      !warning.exporter.startsWith('.') &&
      !warning.exporter.startsWith('@hybridclaw/')
    )
      return;
    throw new Error(warning.message);
  },
});
await bundle.write({ file: 'dist/plugin-sdk.d.ts', format: 'es' });
await bundle.close();
fs.rmSync(declarationsDir, { recursive: true, force: true });
