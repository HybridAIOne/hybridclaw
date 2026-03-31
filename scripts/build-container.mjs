#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const VALID_TARGETS = ['runtime', 'runtime-lite'];

const image = process.env.HYBRIDCLAW_CONTAINER_IMAGE || 'hybridclaw-agent';
const target = process.env.HYBRIDCLAW_CONTAINER_TARGET || 'runtime';

if (!VALID_TARGETS.includes(target)) {
  console.error(
    `Invalid target "${target}". Must be one of: ${VALID_TARGETS.join(', ')}`,
  );
  process.exit(1);
}

const result = spawnSync(
  'docker',
  ['build', '--target', target, '-t', image, './container'],
  { stdio: 'inherit', env: { ...process.env, DOCKER_BUILDKIT: '1' } },
);

if (result.error) throw result.error;
if (result.signal) {
  console.error(`docker build killed by signal ${result.signal}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
