export type SandboxModeOverride = 'container' | 'host';
export type UnsupportedGatewayLifecycleFlag =
  | 'foreground'
  | 'sandbox'
  | 'debug'
  | 'log-requests'
  | 'debug-model-responses';

export interface ParsedGatewayFlags {
  debug: boolean;
  debugModelResponses: boolean;
  foreground: boolean;
  help: boolean;
  logRequests: boolean;
  sandboxMode: SandboxModeOverride | null;
}

function normalizeSandboxMode(value: string): SandboxModeOverride | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'container') return 'container';
  if (normalized === 'host') return 'host';
  return null;
}

function isSandboxFlag(arg: string): boolean {
  const normalized = String(arg || '').trim();
  return normalized === '--sandbox' || normalized.startsWith('--sandbox=');
}

function isForegroundFlag(arg: string): boolean {
  const normalized = String(arg || '').trim();
  return normalized === '--foreground' || normalized === '-f';
}

function isDebugFlag(arg: string): boolean {
  return String(arg || '').trim() === '--debug';
}

function isLogRequestsFlag(arg: string): boolean {
  return String(arg || '').trim() === '--log-requests';
}

function isDebugModelResponsesFlag(arg: string): boolean {
  return String(arg || '').trim() === '--debug-model-responses';
}

function hasSandboxFlag(argv: string[]): boolean {
  return argv.some((arg) => isSandboxFlag(arg));
}

function hasForegroundFlag(argv: string[]): boolean {
  return argv.some((arg) => isForegroundFlag(arg));
}

function hasDebugFlag(argv: string[]): boolean {
  return argv.some((arg) => isDebugFlag(arg));
}

function hasLogRequestsFlag(argv: string[]): boolean {
  return argv.some((arg) => isLogRequestsFlag(arg));
}

function hasDebugModelResponsesFlag(argv: string[]): boolean {
  return argv.some((arg) => isDebugModelResponsesFlag(arg));
}

export function findUnsupportedGatewayLifecycleFlag(
  argv: string[],
): UnsupportedGatewayLifecycleFlag | null {
  if (argv.length === 0) return null;

  const sub = String(argv[0] || '')
    .trim()
    .toLowerCase();
  if (sub === 'start' || sub === 'restart') return null;
  if (hasSandboxFlag(argv)) return 'sandbox';
  if (hasForegroundFlag(argv)) return 'foreground';
  if (hasDebugFlag(argv)) return 'debug';
  if (hasLogRequestsFlag(argv)) return 'log-requests';
  if (hasDebugModelResponsesFlag(argv)) return 'debug-model-responses';
  return null;
}

export function parseGatewayFlags(argv: string[]): ParsedGatewayFlags {
  let debug = false;
  let debugModelResponses = false;
  let foreground = false;
  let help = false;
  let logRequests = false;
  let sandboxMode: SandboxModeOverride | null = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i] || '').trim();
    if (!arg) continue;

    if (isForegroundFlag(arg)) {
      foreground = true;
      continue;
    }

    if (isDebugFlag(arg)) {
      debug = true;
      continue;
    }

    if (isLogRequestsFlag(arg)) {
      logRequests = true;
      continue;
    }

    if (isDebugModelResponsesFlag(arg)) {
      debugModelResponses = true;
      continue;
    }

    if (arg === '--help' || arg === '-h') {
      help = true;
      continue;
    }

    if (arg === '--sandbox') {
      const next = String(argv[i + 1] || '').trim();
      const parsed = normalizeSandboxMode(next);
      if (!parsed) {
        throw new Error(
          `Invalid value for --sandbox: ${next || '<missing>'}. Use --sandbox=container or --sandbox=host.`,
        );
      }
      sandboxMode = parsed;
      i += 1;
      continue;
    }

    if (arg.startsWith('--sandbox=')) {
      const parsed = normalizeSandboxMode(arg.slice('--sandbox='.length));
      if (!parsed) {
        throw new Error(
          `Invalid value for --sandbox: ${arg.slice('--sandbox='.length) || '<missing>'}. Use --sandbox=container or --sandbox=host.`,
        );
      }
      sandboxMode = parsed;
      continue;
    }

    throw new Error(`Unexpected gateway lifecycle option: ${arg}`);
  }

  return {
    debug,
    debugModelResponses,
    foreground,
    help,
    logRequests,
    sandboxMode,
  };
}
