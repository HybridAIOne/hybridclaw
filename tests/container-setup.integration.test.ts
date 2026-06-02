import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { probeDockerAccess } from '../src/infra/container-setup.ts';

const ORIGINAL_PATH = process.env.PATH;
const ORIGINAL_DOCKER_HOST = process.env.DOCKER_HOST;
const tempDirs: string[] = [];

function trackedTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

// Returns a PATH containing only a fake `docker` executable with the given body.
function fakeDockerPath(scriptBody: string): string {
  const dir = trackedTempDir('hc-fakedocker-');
  const bin = path.join(dir, 'docker');
  fs.writeFileSync(bin, `#!/bin/sh\n${scriptBody}\n`);
  fs.chmodSync(bin, 0o755);
  return dir;
}

afterEach(() => {
  process.env.PATH = ORIGINAL_PATH;
  if (ORIGINAL_DOCKER_HOST === undefined) delete process.env.DOCKER_HOST;
  else process.env.DOCKER_HOST = ORIGINAL_DOCKER_HOST;
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Drives the real `docker info` subprocess (no mocks). The Docker-access
// recovery in `ensureRuntimeContainer` branches entirely on this kind, so the
// classification is exercised against real spawn/exit-code/stderr behavior.
describe.skipIf(process.platform === 'win32')(
  'probeDockerAccess (real subprocess)',
  () => {
    test('classifies a responsive daemon as ready', async () => {
      process.env.PATH = fakeDockerPath('exit 0');
      const result = await probeDockerAccess();
      expect(result).toMatchObject({ ready: true, kind: 'ready' });
    });

    test('classifies an absent docker binary as missing', async () => {
      process.env.PATH = trackedTempDir('hc-empty-');
      const result = await probeDockerAccess();
      expect(result.ready).toBe(false);
      expect(result.kind).toBe('missing');
    });

    test('classifies a stopped daemon as daemon-unavailable', async () => {
      process.env.PATH = fakeDockerPath(
        'echo "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?" 1>&2\nexit 1',
      );
      const result = await probeDockerAccess();
      expect(result.ready).toBe(false);
      expect(result.kind).toBe('daemon-unavailable');
    });

    test('classifies a denied socket as permission-denied', async () => {
      process.env.PATH = fakeDockerPath(
        'echo "permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock: connect: permission denied" 1>&2\nexit 1',
      );
      const result = await probeDockerAccess();
      expect(result.ready).toBe(false);
      expect(result.kind).toBe('permission-denied');
    });
  },
);
