#!/usr/bin/env node

const path = require('node:path');
const { spawnSync } = require('node:child_process');

function main() {
  const scriptPath = path.resolve('skills/office/soffice.cjs');
  const args = process.argv.slice(2);
  const result = spawnSync(process.execPath, [scriptPath, 'recalc', ...args], {
    stdio: 'inherit',
  });
  return result.status ?? 1;
}

process.exitCode = main();
