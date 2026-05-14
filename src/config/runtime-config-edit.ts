import { spawnSync } from 'node:child_process';
import {
  normalizeCodexTurnRuntime,
  type RuntimeConfig,
} from './runtime-config.js';

const FORBIDDEN_CONFIG_PATH_SEGMENTS = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

function isConfigObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function splitRuntimeConfigPath(keyPath: string): string[] {
  const segments = keyPath
    .split('.')
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (segments.length === 0) {
    throw new Error('Config key path must not be empty.');
  }
  for (const segment of segments) {
    if (FORBIDDEN_CONFIG_PATH_SEGMENTS.has(segment)) {
      throw new Error(`Config key path \`${keyPath}\` is not allowed.`);
    }
  }
  return segments;
}

export function parseRuntimeConfigCommandValue(rawValue: string): unknown {
  const trimmed = rawValue.trim();
  if (!trimmed) return '';
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return rawValue;
  }
}

export function setRuntimeConfigValueAtPath(
  config: RuntimeConfig,
  keyPath: string,
  value: unknown,
): void {
  const segments = splitRuntimeConfigPath(keyPath);
  if (
    segments.length === 2 &&
    segments[0] === 'codex' &&
    segments[1] === 'runtime' &&
    normalizeCodexTurnRuntime(value) === 'app-server'
  ) {
    assertCodexAppServerRuntimeAvailable();
  }
  let current = config as unknown as Record<string, unknown>;

  for (const segment of segments.slice(0, -1)) {
    const next = current[segment];
    if (!isConfigObject(next)) {
      throw new Error(`Config key \`${keyPath}\` was not found.`);
    }
    current = next;
  }

  const leaf = segments.at(-1);
  if (!leaf) {
    throw new Error('Config key path must not be empty.');
  }
  if (!Object.hasOwn(current, leaf)) {
    throw new Error(`Config key \`${keyPath}\` was not found.`);
  }
  current[leaf] = value;
}

export function assertCodexAppServerRuntimeAvailable(): void {
  const version = spawnSync('codex', ['--version'], {
    encoding: 'utf-8',
  });
  if (version.error) {
    const code = (version.error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new Error(
        'Cannot enable `codex.runtime=app-server`: `codex` is not installed or is not on PATH. Install the OpenAI Codex CLI, then run `hybridclaw config set codex.runtime app-server` again.',
      );
    }
    throw new Error(
      `Cannot enable \`codex.runtime=app-server\`: failed to run \`codex --version\`: ${version.error.message}`,
    );
  }
  if (version.status !== 0) {
    throw new Error(
      `Cannot enable \`codex.runtime=app-server\`: \`codex --version\` exited with ${version.status ?? 'null'}.${version.stderr ? ` ${version.stderr.trim()}` : ''}`,
    );
  }

  const help = spawnSync('codex', ['app-server', '--help'], {
    encoding: 'utf-8',
  });
  if (help.error || help.status !== 0) {
    throw new Error(
      'Cannot enable `codex.runtime=app-server`: the installed Codex CLI does not expose `codex app-server`. Upgrade the OpenAI Codex CLI, then try again.',
    );
  }
}

export function getRuntimeConfigValueAtPath(
  config: RuntimeConfig,
  keyPath: string,
): unknown {
  const segments = splitRuntimeConfigPath(keyPath);
  let current: unknown = config;

  for (const segment of segments) {
    if (!isConfigObject(current) || !Object.hasOwn(current, segment)) {
      throw new Error(`Config key \`${keyPath}\` was not found.`);
    }
    current = current[segment];
  }

  return current;
}

export function formatRuntimeConfigValue(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
