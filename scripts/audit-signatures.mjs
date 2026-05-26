#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

const BAILEYS_RC11_MIN_RELEASE_AGE_EXPIRES_AT = Date.parse(
  '2026-05-20T08:35:12.000Z',
);

const maxAttempts = Number.parseInt(
  process.env.HYBRIDCLAW_NPM_AUDIT_SIGNATURE_ATTEMPTS || '3',
  10,
);
const retryDelayMs = Number.parseInt(
  process.env.HYBRIDCLAW_NPM_AUDIT_SIGNATURE_RETRY_DELAY_MS || '5000',
  10,
);

const baseArgs = [];

// Baileys 7.0.0-rc11 was published on 2026-05-13T08:35:11Z. Until npm's
// seven-day age gate expires, signature audit needs the same resolver bypass
// as install-time CI. After that date, use the repo-wide .npmrc policy again.
if (Date.now() < BAILEYS_RC11_MIN_RELEASE_AGE_EXPIRES_AT) {
  baseArgs.push('--min-release-age=0');
}

const audits = [
  { label: 'root', args: [...baseArgs, 'audit', 'signatures'] },
  {
    label: 'container',
    args: ['--prefix', 'container', ...baseArgs, 'audit', 'signatures'],
  },
];

const transientPatterns = [
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENOTFOUND',
  'fetch failed',
  'aborted',
  'Invalid response body',
  'network connectivity',
];

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isTransientFailure(output) {
  return transientPatterns.some((pattern) => output.includes(pattern));
}

function runAudit(audit) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    console.error(
      `Running npm registry signature audit for ${audit.label} (${attempt}/${maxAttempts})`,
    );

    const result = spawnSync('npm', audit.args, {
      encoding: 'utf8',
      env: {
        ...process.env,
        NPM_CONFIG_CACHE:
          process.env.NPM_CONFIG_CACHE || '/tmp/hybridclaw-npm-cache',
      },
    });

    if (result.stdout) {
      process.stdout.write(result.stdout);
    }
    if (result.stderr) {
      process.stderr.write(result.stderr);
    }

    const status = result.status ?? 1;
    if (status === 0) {
      return 0;
    }

    const output = `${result.stdout || ''}\n${result.stderr || ''}`;
    if (attempt >= maxAttempts || !isTransientFailure(output)) {
      return status;
    }

    console.error(
      `npm registry signature audit for ${audit.label} failed with a transient network error; retrying in ${retryDelayMs}ms.`,
    );
    sleep(retryDelayMs);
  }

  return 1;
}

for (const audit of audits) {
  const status = runAudit(audit);
  if (status !== 0) {
    process.exit(status);
  }
}
