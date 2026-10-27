/**
 * Bounded CLI runner for plugins that wrap an external command (qmd, gbrain,
 * MemPalace, ByteRover): the child sees only an allowlisted environment plus
 * the extras the caller names, stdout and stderr are capped in bytes, and a
 * timeout escalates SIGTERM to SIGKILL. The promise always resolves; failures
 * come back as `{ ok: false, error }` with whatever output was captured.
 *
 * NOT the sandboxed tool runner (`container/`): this runs on the gateway host
 * with the plugin's own trust, and it does not interpret the command's output.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { expandHomePath } from '../utils/path.js';

const CLI_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'TMPDIR',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
];
const CLI_WINDOWS_ENV_ALLOWLIST = [
  'APPDATA',
  'ComSpec',
  'LOCALAPPDATA',
  'PATHEXT',
  'SystemRoot',
  'TEMP',
  'TMP',
  'USERPROFILE',
];
const KILL_GRACE_MS = 250;
const MIN_CAPTURE_BYTES = 32_768;
const CAPTURE_BYTES_PER_CHAR = 2;

export interface BoundedCliOptions {
  command: string;
  args: readonly string[];
  cwd?: string;
  /** Added on top of the allowlisted host environment. */
  env?: Record<string, string>;
  /** No timeout when absent or not a positive number. */
  timeoutMs?: number;
  /** Per-stream byte cap; defaults to two bytes per `maxChars`. */
  maxBytes?: number;
  maxChars?: number;
  /** Product name used in error messages, e.g. `QMD`. */
  label: string;
}

interface BoundedCliOutput {
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export type BoundedCliResult =
  | ({ ok: true } & BoundedCliOutput)
  | ({ ok: false; error: Error } & BoundedCliOutput);

/** The allowlisted host environment plus `extra`, for any plugin subprocess. */
export function buildCliProcessEnv(
  extra: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  const allowlist =
    process.platform === 'win32'
      ? [...CLI_ENV_ALLOWLIST, ...CLI_WINDOWS_ENV_ALLOWLIST]
      : CLI_ENV_ALLOWLIST;
  for (const key of allowlist) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return { ...env, ...extra };
}

/** Resolves a configured path: `~` is the OS home, relative paths join `cwd`. */
export function resolvePluginPath(value: unknown, cwd: string): string {
  const expanded = typeof value === 'string' ? expandHomePath(value) : '';
  return expanded ? path.resolve(cwd, expanded) : '';
}

export function normalizeCliText(value: unknown): string {
  return String(value || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function createCollector(maxBytes: number) {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  let truncated = false;
  return {
    append(chunk: Buffer | string) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = maxBytes - totalBytes;
      if (buffer.length > remaining) truncated = true;
      if (remaining <= 0) return;
      const kept = buffer.subarray(0, remaining);
      totalBytes += kept.length;
      chunks.push(kept);
    },
    read: () => Buffer.concat(chunks).toString('utf-8'),
    get truncated() {
      return truncated;
    },
  };
}

function exitError(
  label: string,
  code: number | null,
  output: BoundedCliOutput,
): Error {
  const message =
    normalizeCliText(output.stderr) ||
    normalizeCliText(output.stdout) ||
    `${label} exited with code ${String(code)}.`;
  return new Error(
    output.stderrTruncated
      ? `${message}\n\n[${label} stderr truncated]`
      : message,
  );
}

export async function runBoundedCli(
  options: BoundedCliOptions,
): Promise<BoundedCliResult> {
  const { label, timeoutMs } = options;
  const maxBytes = Math.max(
    MIN_CAPTURE_BYTES,
    Math.trunc(
      options.maxBytes ?? (options.maxChars ?? 0) * CAPTURE_BYTES_PER_CHAR,
    ),
  );
  return await new Promise((resolve) => {
    const child = spawn(options.command, [...options.args], {
      cwd: options.cwd,
      env: buildCliProcessEnv(options.env),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = createCollector(maxBytes);
    const stderr = createCollector(maxBytes);
    let settled = false;
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;

    const finish = (fail?: (output: BoundedCliOutput) => Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      const output: BoundedCliOutput = {
        stdout: stdout.read(),
        stderr: stderr.read(),
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
      };
      resolve(
        fail
          ? { ok: false, error: fail(output), ...output }
          : { ok: true, ...output },
      );
    };

    const timer =
      typeof timeoutMs === 'number' &&
      Number.isFinite(timeoutMs) &&
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill('SIGTERM');
            killTimer = setTimeout(() => {
              if (!settled) child.kill('SIGKILL');
            }, KILL_GRACE_MS);
          }, timeoutMs)
        : undefined;

    child.stdout?.on('data', (chunk) => stdout.append(chunk));
    child.stderr?.on('data', (chunk) => stderr.append(chunk));
    child.on('error', (error) => finish(() => error));
    child.on('close', (code, signal) => {
      if (timedOut) {
        finish(() => new Error(`${label} timed out after ${timeoutMs}ms.`));
      } else if (signal) {
        finish(() => new Error(`${label} terminated with signal ${signal}.`));
      } else if (code !== 0) {
        finish((output) => exitError(label, code, output));
      } else {
        finish();
      }
    });
  });
}
