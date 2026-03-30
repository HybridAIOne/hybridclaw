import {
  CONTAINER_IMAGE,
  getResolvedSandboxMode,
} from '../../config/config.js';
import {
  isContainerSandboxModeExplicit,
  updateRuntimeConfig,
} from '../../config/runtime-config.js';
import {
  containerImageExists,
  ensureContainerImageReady,
  probeDockerAccess,
} from '../../infra/container-setup.js';
import { resolveInstallRoot } from '../../infra/install-root.js';
import type { DiagResult } from '../types.js';
import { makeResult } from '../utils.js';

export async function checkDocker(): Promise<DiagResult[]> {
  const dockerAccess = await probeDockerAccess();
  const daemonReady = dockerAccess.ready;
  const imagePresent = daemonReady
    ? await containerImageExists(CONTAINER_IMAGE)
    : false;
  const resolvedSandboxMode = getResolvedSandboxMode();
  const dockerRequired = resolvedSandboxMode !== 'host';
  const sandboxModeExplicit = isContainerSandboxModeExplicit();

  if (!daemonReady) {
    const fix =
      dockerRequired &&
      !sandboxModeExplicit &&
      (dockerAccess.kind === 'missing' ||
        dockerAccess.kind === 'permission-denied')
        ? {
            summary: 'Switch runtime sandbox mode to host',
            apply: async () => {
              updateRuntimeConfig((draft) => {
                draft.container.sandboxMode = 'host';
              });
            },
          }
        : undefined;
    return [
      makeResult(
        'docker',
        'Docker',
        dockerRequired ? 'error' : 'warn',
        dockerAccess.kind === 'missing'
          ? dockerRequired
            ? `Docker unavailable (${dockerAccess.detail}); sandbox mode \`${resolvedSandboxMode}\` requires Docker. Use \`--sandbox=host\` or set \`container.sandboxMode\` to \`host\`.`
            : `Docker unavailable (${dockerAccess.detail})`
          : dockerAccess.kind === 'permission-denied'
            ? dockerRequired
              ? `Docker is installed but the current user cannot access the Docker daemon (${dockerAccess.detail}); sandbox mode \`${resolvedSandboxMode}\` requires Docker access. Add this user to the \`docker\` group, start a new login shell, or use \`--sandbox=host\` / \`container.sandboxMode=host\`.`
              : `Docker is installed but the current user cannot access the Docker daemon (${dockerAccess.detail}). Add this user to the \`docker\` group or start a new login shell.`
            : dockerRequired
              ? `Docker daemon not ready (${dockerAccess.detail}); sandbox mode \`${resolvedSandboxMode}\` requires Docker. Use \`--sandbox=host\` or set \`container.sandboxMode\` to \`host\`.`
              : `Docker daemon not ready (${dockerAccess.detail})`,
        fix,
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
