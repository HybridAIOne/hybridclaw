import { spawn } from 'node:child_process';

const MEMPALACE_ENV_ALLOWLIST = [
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
const MEMPALACE_WINDOWS_ENV_ALLOWLIST = [
  'APPDATA',
  'ComSpec',
  'LOCALAPPDATA',
  'PATHEXT',
  'SystemRoot',
  'TEMP',
  'TMP',
  'USERPROFILE',
];
const PROCESS_KILL_GRACE_MS = 250;
const MIN_CAPTURE_BYTES = 32_768;
const CAPTURE_BYTES_PER_CHAR = 2;

function normalizeText(value) {
  return String(value || '')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function truncateText(value, maxChars) {
  const normalized = normalizeText(value);
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function buildProcessEnv() {
  const env = {};
  const allowlist =
    process.platform === 'win32'
      ? [...MEMPALACE_ENV_ALLOWLIST, ...MEMPALACE_WINDOWS_ENV_ALLOWLIST]
      : MEMPALACE_ENV_ALLOWLIST;

  for (const key of allowlist) {
    const value = process.env[key];
    if (typeof value === 'string' && value.length > 0) {
      env[key] = value;
    }
  }

  return env;
}

function resolveCaptureLimitBytes(maxChars) {
  const configuredBudget =
    typeof maxChars === 'number' && Number.isFinite(maxChars)
      ? Math.max(0, Math.trunc(maxChars)) * CAPTURE_BYTES_PER_CHAR
      : 0;
  return Math.max(MIN_CAPTURE_BYTES, configuredBudget);
}

function createOutputCollector(maxBytes) {
  return {
    maxBytes,
    totalBytes: 0,
    truncated: false,
    chunks: [],
  };
}

function appendOutputChunk(collector, chunk) {
  const buffer = Buffer.isBuffer(chunk)
    ? chunk
    : Buffer.from(String(chunk), 'utf-8');
  const remaining = collector.maxBytes - collector.totalBytes;
  if (remaining <= 0) {
    collector.truncated = true;
    return;
  }

  if (buffer.length <= remaining) {
    collector.totalBytes += buffer.length;
    collector.chunks.push(buffer);
    return;
  }

  collector.totalBytes += remaining;
  collector.chunks.push(buffer.subarray(0, remaining));
  collector.truncated = true;
}

function readCollectedOutput(collector) {
  if (collector.chunks.length === 0) return '';
  return Buffer.concat(collector.chunks).toString('utf-8');
}

function buildInvocationArgs(subcommandArgs, config) {
  const args = [];
  if (config.palacePath) {
    args.push('--palace', config.palacePath);
  }
  args.push(...subcommandArgs);
  return args;
}

export async function runMempalace(subcommandArgs, config, options = {}) {
  const timeoutMs =
    typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs)
      ? options.timeoutMs
      : config.timeoutMs;
  const captureLimitBytes = resolveCaptureLimitBytes(options.maxChars);
  const args = buildInvocationArgs(subcommandArgs, config);

  return await new Promise((resolve) => {
    const child = spawn(config.command, args, {
      cwd: config.workingDirectory,
      env: buildProcessEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdoutCollector = createOutputCollector(captureLimitBytes);
    const stderrCollector = createOutputCollector(captureLimitBytes);
    let settled = false;
    let timedOut = false;
    let killTimer = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      resolve({
        ...result,
        stdout: readCollectedOutput(stdoutCollector),
        stderr: readCollectedOutput(stderrCollector),
        stdoutTruncated: stdoutCollector.truncated,
        stderrTruncated: stderrCollector.truncated,
      });
    };

    const timer =
      typeof timeoutMs === 'number' &&
      Number.isFinite(timeoutMs) &&
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill('SIGTERM');
            killTimer = setTimeout(() => {
              if (!settled) {
                child.kill('SIGKILL');
              }
            }, PROCESS_KILL_GRACE_MS);
          }, timeoutMs)
        : null;

    child.stdout?.on('data', (chunk) =>
      appendOutputChunk(stdoutCollector, chunk),
    );
    child.stderr?.on('data', (chunk) =>
      appendOutputChunk(stderrCollector, chunk),
    );
    child.on('error', (error) => finish({ ok: false, error }));
    child.on('close', (code, signal) => {
      if (timedOut) {
        finish({
          ok: false,
          error: new Error(`MemPalace timed out after ${timeoutMs}ms.`),
        });
        return;
      }
      if (signal) {
        finish({
          ok: false,
          error: new Error(`MemPalace terminated with signal ${signal}.`),
        });
        return;
      }
      if (code !== 0) {
        const stderrText = normalizeText(readCollectedOutput(stderrCollector));
        const errorMessage = stderrText
          ? `${stderrText}${stderrCollector.truncated ? '\n[stderr truncated]' : ''}`
          : `MemPalace exited with code ${code}.`;
        finish({
          ok: false,
          error: new Error(errorMessage),
        });
        return;
      }
      finish({ ok: true });
    });
  });
}

export async function runMempalaceCommandText(subcommandArgs, config, options) {
  const result = await runMempalace(subcommandArgs, config, options);
  if (!result.ok) {
    throw result.error;
  }
  return normalizeText(result.stdout);
}

export function cleanWakeUpText(value, maxChars) {
  const normalized = normalizeText(value)
    .replace(/^Wake-up text\s*\(~\d+\s+tokens\):\n=+\n?/i, '')
    .trim();
  return truncateText(normalized, maxChars);
}

export function cleanSearchText(value, maxChars) {
  return truncateText(normalizeText(value), maxChars);
}
