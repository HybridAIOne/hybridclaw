#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

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

const auditPolicyArgs = [];

// Baileys 7.0.0-rc11 was published on 2026-05-13T08:35:11Z. Until npm's
// seven-day age gate expires, signature audit needs the same resolver bypass
// as install-time CI. After that date, use the repo-wide .npmrc policy again.
if (Date.now() < BAILEYS_RC11_MIN_RELEASE_AGE_EXPIRES_AT) {
  auditPolicyArgs.push('--min-release-age=0');
}

const targets = [
  {
    label: 'root',
    args: [...auditPolicyArgs, 'audit', 'signatures'],
  },
  {
    label: 'container',
    args: ['--prefix', 'container', ...auditPolicyArgs, 'audit', 'signatures'],
  },
];

const transientPatterns = [
  /E404[\s\S]*\/-\/npm\/v1\/attestations\//u,
  /E5\d\d/u,
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENOTFOUND',
  'fetch failed',
  'aborted',
  'Invalid response body',
  'network connectivity',
  'socket hang up',
];

function auditCacheDir(label) {
  return path.join(os.tmpdir(), `hybridclaw-npm-cache-${label}`);
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isTransientFailure(output) {
  return transientPatterns.some((pattern) =>
    typeof pattern === 'string'
      ? output.includes(pattern)
      : pattern.test(output),
  );
}

function runAudit(target) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    console.error(
      `Running npm registry signature audit for ${target.label} (${attempt}/${maxAttempts})`,
    );

    const result = spawnSync('npm', target.args, {
      encoding: 'utf8',
      env: {
        ...process.env,
        NPM_CONFIG_CACHE:
          process.env.NPM_CONFIG_CACHE || auditCacheDir(target.label),
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
      `npm registry signature audit for ${target.label} failed with a transient network error; retrying in ${retryDelayMs}ms.`,
    );
    sleep(retryDelayMs);
  }

  return 1;
}

for (const target of targets) {
  const status = runAudit(target);
  if (status !== 0) {
    process.exit(status);
  }
}
