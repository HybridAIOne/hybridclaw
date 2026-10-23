#!/usr/bin/env node
/**
 * Bundle entry for dist/cli.js — the Node version guard runs before any other
 * module loads.
 *
 * esbuild hoists every chunk a module imports statically ahead of its body, so
 * the guard import at the top of cli.ts would run after most of the gateway.
 * Here the guard is the only static import and the CLI loads after it.
 * `tsx src/cli.ts` does not use this file; cli.ts imports the guard itself.
 */
import './node-version-guard.js';

const { runCli } = await import('./cli.js');
runCli();
