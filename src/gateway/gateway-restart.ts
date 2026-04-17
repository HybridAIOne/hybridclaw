import { spawn } from 'node:child_process';
import { type GatewayPidState, readGatewayPid } from './gateway-lifecycle.js';

const GATEWAY_SUBCOMMANDS = new Set(['start', 'restart']);
const GATEWAY_RESTART_WAIT_MS = 15_000;
const GATEWAY_RESTART_POLL_MS = 100;

export interface GatewayLifecycleStatus {
  restartSupported: boolean;
  restartReason: string | null;
}

export interface GatewayExternalRestartResult {
  status: 'restarted' | 'not-running' | 'failed';
  pid: number | null;
  reason: string | null;
}

interface GatewayRestartPayload {
  parentPid: number;
  cwd: string;
  command: string[];
}

function isPidRunning(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function findGatewayCommandIndex(command: readonly string[]): number {
  for (let index = 0; index < command.length - 1; index += 1) {
    if (
      command[index] === 'gateway' &&
      GATEWAY_SUBCOMMANDS.has(command[index + 1] || '')
    ) {
      return index;
    }
  }
  return -1;
}

export function normalizeGatewayRestartCommand(
  command: readonly string[],
): string[] | null {
  const gatewayIndex = findGatewayCommandIndex(command);
  if (gatewayIndex < 0) return null;

  const normalized = [...command];
  normalized[gatewayIndex + 1] = 'start';
  if (!normalized.includes('--foreground')) {
    normalized.splice(gatewayIndex + 2, 0, '--foreground');
  }
  return normalized;
}

function resolveGatewayRestartHelperCommand(
  command: readonly string[],
): string[] | null {
  const gatewayIndex = findGatewayCommandIndex(command);
  if (gatewayIndex < 0) return null;
  return [...command.slice(0, gatewayIndex), '__gateway-restart-helper'];
}

function encodePayload(payload: GatewayRestartPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64url');
}

function decodePayload(raw: string): GatewayRestartPayload {
  const parsed = JSON.parse(
    Buffer.from(raw, 'base64url').toString('utf-8'),
  ) as Partial<GatewayRestartPayload>;
  if (
    !parsed ||
    typeof parsed.parentPid !== 'number' ||
    !Number.isFinite(parsed.parentPid) ||
    typeof parsed.cwd !== 'string' ||
    !Array.isArray(parsed.command)
  ) {
    throw new Error('Invalid gateway restart payload.');
  }
  const command = parsed.command.map((entry) => String(entry));
  if (command.length === 0) {
    throw new Error('Missing gateway restart command.');
  }
  return {
    parentPid: parsed.parentPid,
    cwd: parsed.cwd,
    command,
  };
}

function resolveRestartState(
  params: { currentPid?: number; state?: GatewayPidState | null } = {},
): {
  helperCommand: string[] | null;
  restartCommand: string[] | null;
  cwd: string;
  restartReason: string | null;
} {
  const state = params.state ?? readGatewayPid();
  const currentPid = params.currentPid ?? process.pid;
  if (!state) {
    return {
      helperCommand: null,
      restartCommand: null,
      cwd: process.cwd(),
      restartReason: 'Gateway restart is unavailable: no CLI PID file found.',
    };
  }
  if (state.pid !== currentPid) {
    return {
      helperCommand: null,
      restartCommand: null,
      cwd: state.cwd || process.cwd(),
      restartReason:
        'Gateway restart is unavailable: this process is not the active CLI-managed gateway.',
    };
  }

  const restartCommand = normalizeGatewayRestartCommand(state.command);
  if (!restartCommand) {
    return {
      helperCommand: null,
      restartCommand: null,
      cwd: state.cwd || process.cwd(),
      restartReason:
        'Gateway restart is unavailable: the recorded launch command cannot be replayed.',
    };
  }

  const helperCommand = resolveGatewayRestartHelperCommand(state.command);
  if (!helperCommand) {
    return {
      helperCommand: null,
      restartCommand: null,
      cwd: state.cwd || process.cwd(),
      restartReason:
        'Gateway restart is unavailable: the CLI helper command could not be resolved.',
    };
  }

  return {
    helperCommand,
    restartCommand,
    cwd: state.cwd || process.cwd(),
    restartReason: null,
  };
}

export function getGatewayLifecycleStatus(
  params: { currentPid?: number; state?: GatewayPidState | null } = {},
): GatewayLifecycleStatus {
  const resolved = resolveRestartState(params);
  return {
    restartSupported:
      resolved.helperCommand !== null && resolved.restartCommand !== null,
    restartReason: resolved.restartReason,
  };
}

function spawnRestartHelper(
  helperCommand: readonly string[],
  payload: GatewayRestartPayload,
  cwd: string,
): void {
  const helper = spawn(
    helperCommand[0],
    [...helperCommand.slice(1), encodePayload(payload)],
    {
      cwd,
      detached: true,
      stdio: 'ignore',
      env: process.env,
    },
  );
  helper.unref();
}

export function requestGatewayRestart(
  params: { currentPid?: number; state?: GatewayPidState | null } = {},
): GatewayLifecycleStatus {
  const currentPid = params.currentPid ?? process.pid;
  const resolved = resolveRestartState({
    currentPid,
    state: params.state,
  });
  if (!resolved.helperCommand || !resolved.restartCommand) {
    return {
      restartSupported: false,
      restartReason: resolved.restartReason,
    };
  }

  spawnRestartHelper(
    resolved.helperCommand,
    {
      parentPid: currentPid,
      cwd: resolved.cwd,
      command: resolved.restartCommand,
    },
    resolved.cwd,
  );

  return {
    restartSupported: true,
    restartReason: null,
  };
}

export function requestExternalGatewayRestart(
  params: { state?: GatewayPidState | null } = {},
): GatewayExternalRestartResult {
  const state = params.state === undefined ? readGatewayPid() : params.state;
  if (!state) {
    return { status: 'not-running', pid: null, reason: null };
  }
  if (!isPidRunning(state.pid)) {
    return { status: 'not-running', pid: state.pid, reason: null };
  }

  const restartCommand = normalizeGatewayRestartCommand(state.command);
  const helperCommand = resolveGatewayRestartHelperCommand(state.command);
  if (!restartCommand || !helperCommand) {
    return {
      status: 'failed',
      pid: state.pid,
      reason: 'Recorded gateway launch command cannot be replayed.',
    };
  }

  const cwd = state.cwd || process.cwd();

  try {
    spawnRestartHelper(
      helperCommand,
      { parentPid: state.pid, cwd, command: restartCommand },
      cwd,
    );
  } catch (err) {
    return {
      status: 'failed',
      pid: state.pid,
      reason: `Failed to spawn restart helper: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  try {
    process.kill(state.pid, 'SIGTERM');
  } catch (err) {
    return {
      status: 'failed',
      pid: state.pid,
      reason: `Failed to signal gateway pid ${state.pid}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return { status: 'restarted', pid: state.pid, reason: null };
}

async function waitForParentExit(pid: number): Promise<void> {
  const deadline = Date.now() + GATEWAY_RESTART_WAIT_MS;
  while (Date.now() < deadline) {
    if (!isPidRunning(pid)) return;
    await new Promise((resolve) =>
      setTimeout(resolve, GATEWAY_RESTART_POLL_MS),
    );
  }
  if (isPidRunning(pid)) {
    throw new Error(
      `Gateway restart timed out waiting for pid ${pid} to exit.`,
    );
  }
}

export async function runGatewayRestartHelperFromArg(
  rawPayload: string,
): Promise<void> {
  const payload = decodePayload(rawPayload);
  await waitForParentExit(payload.parentPid);
  const child = spawn(payload.command[0], payload.command.slice(1), {
    cwd: payload.cwd || process.cwd(),
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();
}
