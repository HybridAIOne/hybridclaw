#!/usr/bin/env node

import fs from 'node:fs';

// npm updates shrinkwraps in preference to package-lock.json when both exist.
const pairs = [
  ['npm-shrinkwrap.json', 'package-lock.json'],
  ['container/npm-shrinkwrap.json', 'container/package-lock.json'],
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
