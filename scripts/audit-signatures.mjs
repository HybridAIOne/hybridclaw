#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const maxAttempts = Number.parseInt(
  process.env.HYBRIDCLAW_NPM_AUDIT_SIGNATURE_ATTEMPTS || '3',
  10,
);
const retryDelayMs = Number.parseInt(
  process.env.HYBRIDCLAW_NPM_AUDIT_SIGNATURE_RETRY_DELAY_MS || '5000',
  10,
);

const jsrRegistryArg = '--@jsr:registry=https://npm.jsr.io';

const targets = [
  {
    label: 'root',
    args: [jsrRegistryArg, 'audit', 'signatures'],
  },
  {
    label: 'container',
    args: ['--prefix', 'container', jsrRegistryArg, 'audit', 'signatures'],
  },
];
const missingAttestationPattern = /E404[\s\S]*\/-\/npm\/v1\/attestations\//u;

const signatureFailurePatterns = [
  /packages? (?:has|have) missing registry signatures/iu,
  /packages? (?:has|have) invalid registry signatures/iu,
  /packages? (?:has|have) (?:an? )?invalid attestations?/iu,
  /could not find registry signing key/iu,
  /EINTEGRITY/u,
];

const transientPatterns = [
  missingAttestationPattern,
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

export function isMissingAttestationFailure(output) {
  return missingAttestationPattern.test(output);
}

export function hasSignatureValidationFailure(output) {
  return signatureFailurePatterns.some((pattern) => pattern.test(output));
}

export function shouldAllowMissingAttestationFailure(output) {
  return (
    isMissingAttestationFailure(output) &&
    !hasSignatureValidationFailure(output)
  );
}

export function isTransientFailure(output) {
  return transientPatterns.some((pattern) =>
    typeof pattern === 'string'
      ? output.includes(pattern)
      : pattern.test(output),
  );
}

export function runAudit(target) {
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
      if (shouldAllowMissingAttestationFailure(output)) {
        console.error(
          `npm registry signature audit for ${target.label} could not fetch npm provenance attestations (registry returned 404). Treating attestation availability as best-effort because no registry signature validation failure was reported.`,
        );
        return 0;
      }
      return status;
    }

    const reason = isMissingAttestationFailure(output)
      ? 'a registry attestation lookup error'
      : 'a transient registry availability error';
    console.error(
      `npm registry signature audit for ${target.label} failed with ${reason}; retrying in ${retryDelayMs}ms.`,
    );
    sleep(retryDelayMs);
  }

  return 1;
}

export function main() {
  for (const target of targets) {
    const status = runAudit(target);
    if (status !== 0) {
      return status;
    }
  }
  return 0;
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  process.exitCode = main();
}
