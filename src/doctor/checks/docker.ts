import { spawnSync } from 'node:child_process';
import { CONTAINER_IMAGE } from '../../config/config.js';
import { getRuntimeConfig } from '../../config/runtime-config.js';
import {
  containerImageExists,
  ensureContainerImageReady,
} from '../../infra/container-setup.js';
import { resolveInstallRoot } from '../../infra/install-root.js';
import type { DiagResult } from '../types.js';
import { makeResult } from '../utils.js';

export async function checkDocker(): Promise<DiagResult[]> {
  const config = getRuntimeConfig();
  const dockerInfo = spawnSync('docker', ['info'], {
    encoding: 'utf-8',
  });
  const daemonReady = !dockerInfo.error && dockerInfo.status === 0;
  const imagePresent = daemonReady
    ? await containerImageExists(CONTAINER_IMAGE)
    : false;
  const activeSandbox = config.container.sandboxMode === 'container';

  if (!daemonReady) {
    return [
      makeResult(
        'docker',
        'Docker',
        activeSandbox ? 'error' : 'warn',
        dockerInfo.error
          ? `Docker unavailable (${dockerInfo.error.message})`
          : `Docker daemon not ready${dockerInfo.stderr ? ` (${dockerInfo.stderr.trim()})` : ''}`,
      ),
    ];
  }

  if (!imagePresent) {
    return [
      makeResult(
        'docker',
        'Docker',
        'warn',
        `Image ${CONTAINER_IMAGE} not found locally; run: npm run build:container`,
        {
          summary: `Build the ${CONTAINER_IMAGE} container image`,
          apply: async () => {
            await ensureContainerImageReady({
              commandName: 'hybridclaw doctor --fix',
              required: false,
              cwd: resolveInstallRoot(),
            });
          },
        },
      ),
    ];
  }

  return [
    makeResult(
      'docker',
      'Docker',
      'ok',
      `Daemon running, image ${CONTAINER_IMAGE} present`,
    ),
  ];
}
