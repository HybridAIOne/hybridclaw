import { gatewayHealth } from '../../gateway/gateway-client.js';
import {
  isPidRunning,
  readGatewayPid,
  removeGatewayPidFile,
} from '../../gateway/gateway-lifecycle.js';
import type { GatewayStatus } from '../../gateway/gateway-types.js';
import { restartGatewayFromDoctor } from '../gateway-repair.js';
import type { DiagResult } from '../types.js';
import { formatDuration, makeResult, toErrorMessage } from '../utils.js';

export async function checkGateway(): Promise<DiagResult[]> {
  const pidState = readGatewayPid();
  const pidRunning = Boolean(pidState && isPidRunning(pidState.pid));
  let health: GatewayStatus | null = null;
  let apiError = '';
  const removeStalePidFix: NonNullable<DiagResult['fix']> = {
    summary: 'Remove the stale gateway PID file',
    apply: async () => {
      removeGatewayPidFile();
    },
  };

  try {
    health = await gatewayHealth();
  } catch (error) {
    apiError = toErrorMessage(error);
  }

  if (health && pidRunning) {
    return [
      makeResult(
        'gateway',
        'Gateway',
        'ok',
        `PID ${pidState?.pid}, uptime ${formatDuration(health.uptime)}, ${health.sessions} session${health.sessions === 1 ? '' : 's'}`,
      ),
    ];
  }

  if (health && !pidRunning) {
    return [
      makeResult(
        'gateway',
        'Gateway',
        'warn',
        pidState
          ? 'Gateway reachable, but the local PID file is stale'
          : 'Gateway reachable, but no managed PID file is present',
        pidState ? removeStalePidFix : undefined,
      ),
    ];
  }

  if (pidState && !pidRunning) {
    return [
      makeResult(
        'gateway',
        'Gateway',
        'warn',
        `Stale PID file for pid ${pidState.pid}; gateway API is unreachable`,
        removeStalePidFix,
      ),
    ];
  }

  if (pidRunning) {
    return [
      makeResult(
        'gateway',
        'Gateway',
        'error',
        `PID ${pidState?.pid} is running, but the gateway API is unreachable${apiError ? ` (${apiError})` : ''}`,
        {
          summary:
            'Kill the stale gateway process and restart the managed gateway',
          apply: async () => {
            await restartGatewayFromDoctor();
          },
        },
      ),
    ];
  }

  return [
    makeResult(
      'gateway',
      'Gateway',
      'warn',
      `Gateway is not running${apiError ? ` (${apiError})` : ''}`,
    ),
  ];
}
