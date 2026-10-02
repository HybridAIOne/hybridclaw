/**
 * Shell launch keeps command text, wrapper paths, and short-lived credentials
 * out of argv: argv holds only constants, and everything else arrives as
 * NUL-terminated stdin fields or environment values. Unlike the bash tool
 * dispatcher, this module neither approves commands nor resolves credentials;
 * it only supplies the approved process environment.
 */
import { spawnSync } from 'node:child_process';
import { buildSanitizedEnv } from '../shared/sensitive-env.js';
import { WORKSPACE_ROOT } from './runtime-paths.js';

export const BASH_EXEC_MAX_BUFFER_BYTES = 4 * 1024 * 1024;

export const BASH_DOCKER_CONTAINER = String(
  process.env.HYBRIDCLAW_BASH_DOCKER_CONTAINER || '',
).trim();
export const BASH_DOCKER_CWD = String(
  process.env.HYBRIDCLAW_BASH_DOCKER_CWD || '/app',
).trim();
export const TASK_SANDBOX_FS_ENABLED = Boolean(BASH_DOCKER_CONTAINER);

export function runBashProcess(
  args: string[],
  params: {
    command: string;
    timeoutMs: number;
    runtimeEnv: Record<string, string>;
  },
  // Fields the wrapper script reads from stdin before the command.
  stdinFields: string[] = [],
) {
  const env = buildSanitizedEnv(process.env);
  const gatewayUrl = String(process.env.HYBRIDCLAW_GATEWAY_URL || '').trim();
  const gatewayToken = String(
    process.env.HYBRIDCLAW_GATEWAY_TOKEN || '',
  ).trim();
  if (gatewayUrl) env.HYBRIDCLAW_GATEWAY_URL = gatewayUrl;
  if (gatewayToken) env.HYBRIDCLAW_GATEWAY_TOKEN = gatewayToken;
  const options = {
    input: [...stdinFields, params.command]
      .map((field) => `${field}\0`)
      .join(''),
    timeout: params.timeoutMs,
    encoding: 'utf-8' as const,
    maxBuffer: BASH_EXEC_MAX_BUFFER_BYTES,
  };
  if (TASK_SANDBOX_FS_ENABLED) {
    return spawnSync(
      'docker',
      [
        'exec',
        '-i',
        '-w',
        BASH_DOCKER_CWD || '/app',
        ...Object.keys(params.runtimeEnv).flatMap((name) => ['-e', name]),
        BASH_DOCKER_CONTAINER,
        'bash',
        ...args,
      ],
      { ...options, env: { ...process.env, ...params.runtimeEnv } },
    );
  }
  return spawnSync('bash', args, {
    ...options,
    cwd: WORKSPACE_ROOT,
    env: { ...env, ...params.runtimeEnv },
  });
}
