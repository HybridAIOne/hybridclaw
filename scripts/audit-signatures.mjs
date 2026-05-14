#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

const BAILEYS_RC11_MIN_RELEASE_AGE_EXPIRES_AT = Date.parse(
  '2026-05-20T08:35:12.000Z',
);

const args = [];

// Baileys 7.0.0-rc11 was published on 2026-05-13T08:35:11Z. Until npm's
// seven-day age gate expires, signature audit needs the same resolver bypass
// as install-time CI. After that date, use the repo-wide .npmrc policy again.
if (Date.now() < BAILEYS_RC11_MIN_RELEASE_AGE_EXPIRES_AT) {
  args.push('--min-release-age=0');
}

args.push('audit', 'signatures');

const result = spawnSync('npm', args, {
  stdio: 'inherit',
  env: {
    ...process.env,
    NPM_CONFIG_CACHE:
      process.env.NPM_CONFIG_CACHE || '/tmp/hybridclaw-npm-cache',
  },
});

process.exit(result.status ?? 1);
