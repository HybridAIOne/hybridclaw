import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

// A `node --require` preload that fails node-pty's own `pty.node` load, the
// way a missing or ABI-broken prebuild does, while a marker file exists.
// `repair()` deletes the marker and stands in for `npm rebuild node-pty`. The
// shared node_modules is never touched.
const PRELOAD = `const fs = require('node:fs');
const Module = require('node:module');
const marker = process.env.HYBRIDCLAW_TEST_BROKEN_NODE_PTY_MARKER;
const load = Module._load;
Module._load = function (request, ...rest) {
  if (/(^|\\/)pty\\.node$/.test(request) && marker && fs.existsSync(marker)) {
    throw new Error('simulated broken node-pty prebuild');
  }
  return load.call(this, request, ...rest);
};
`;

export function brokenNodePty(dir: string): {
  nodeArgs: string[];
  env: Record<string, string>;
  repair: () => void;
} {
  const preloadPath = path.join(dir, 'break-node-pty.cjs');
  const markerPath = path.join(dir, 'node-pty-broken');
  fs.writeFileSync(preloadPath, PRELOAD);
  fs.writeFileSync(markerPath, '');
  return {
    nodeArgs: ['--require', preloadPath],
    env: { HYBRIDCLAW_TEST_BROKEN_NODE_PTY_MARKER: markerPath },
    repair: () => fs.rmSync(markerPath),
  };
}

export function nodePtyLoads(): boolean {
  try {
    createRequire(import.meta.url)('node-pty');
    return true;
  } catch {
    return false;
  }
}
