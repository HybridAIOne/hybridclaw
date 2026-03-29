import { spawnSync } from 'node:child_process';
import { CONTAINER_IMAGE, getResolvedSandboxMode } from '../../config/config.js';
import {
  containerImageExists,
  ensureContainerImageReady,
} from '../../infra/container-setup.js';
import { resolveInstallRoot } from '../../infra/install-root.js';
import type { DiagResult } from '../types.js';
import { makeResult } from '../utils.js';

export async function checkDocker(): Promise<DiagResult[]> {
  const dockerInfo = spawnSync('docker', ['info'], {
    encoding: 'utf-8',
  });
  const daemonReady = !dockerInfo.error && dockerInfo.status === 0;
  const imagePresent = daemonReady
    ? await containerImageExists(CONTAINER_IMAGE)
    : false;
  const resolvedSandboxMode = getResolvedSandboxMode();
  const dockerRequired = resolvedSandboxMode !== 'host';

  if (!daemonReady) {
    return [
      makeResult(
        'docker',
        'Docker',
        dockerRequired ? 'error' : 'warn',
        dockerInfo.error
          ? dockerRequired
            ? `Docker unavailable (${dockerInfo.error.message}); sandbox mode \`${resolvedSandboxMode}\` requires Docker. Use \`--sandbox=host\` or set \`container.sandboxMode\` to \`host\`.`
            : `Docker unavailable (${dockerInfo.error.message})`
          : dockerRequired
            ? `Docker daemon not ready${dockerInfo.stderr ? ` (${dockerInfo.stderr.trim()})` : ''}; sandbox mode \`${resolvedSandboxMode}\` requires Docker. Use \`--sandbox=host\` or set \`container.sandboxMode\` to \`host\`.`
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
