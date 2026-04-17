#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VALID_TARGETS = ['runtime', 'runtime-lite'];

const image = process.env.HYBRIDCLAW_CONTAINER_IMAGE || 'hybridclaw-agent';
const target = process.env.HYBRIDCLAW_CONTAINER_TARGET || 'runtime';

function resolveContainerVersion() {
  const envVersion = (process.env.HYBRIDCLAW_CONTAINER_VERSION || '').trim();
  if (envVersion) return envVersion;

  try {
    const scriptDir = path.dirname(fileURLToPath(import.meta.url));
    const packageJsonPath = path.join(
      scriptDir,
      '..',
      'container',
      'package.json',
    );
    const parsed = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
    if (typeof parsed?.version === 'string' && parsed.version.trim()) {
      return parsed.version.trim();
    }
  } catch {
    // Fall through to the default below.
  }

  return '0.0.0';
}

const version = resolveContainerVersion();

if (!VALID_TARGETS.includes(target)) {
  console.error(
    `Invalid target "${target}". Must be one of: ${VALID_TARGETS.join(', ')}`,
  );
  process.exit(1);
}

const result = spawnSync(
  'docker',
  [
    'build',
    '--target',
    target,
    '--build-arg',
    `HYBRIDCLAW_VERSION=${version}`,
    '-t',
    image,
    './container',
  ],
  { stdio: 'inherit', env: { ...process.env, DOCKER_BUILDKIT: '1' } },
);

if (result.error) throw result.error;
if (result.signal) {
  console.error(`docker build killed by signal ${result.signal}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
