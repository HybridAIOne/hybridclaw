#!/usr/bin/env node

import fs from 'node:fs';

const pairs = [
  ['package-lock.json', 'npm-shrinkwrap.json'],
  ['container/package-lock.json', 'container/npm-shrinkwrap.json'],
];

for (const [source, target] of pairs) {
  if (!fs.existsSync(source)) {
    console.error(`sync-shrinkwraps: missing ${source}`);
    process.exitCode = 1;
    continue;
  }
  fs.copyFileSync(source, target);
  console.log(`synced ${target}`);
}
