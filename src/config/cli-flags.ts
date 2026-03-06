export type SandboxModeOverride = 'container' | 'host';
export type UnsupportedGatewayLifecycleFlag =
  | 'foreground'
  | 'sandbox'
  | 'debug';

export interface ParsedGatewayFlags {
  debug: boolean;
  foreground: boolean;
  help: boolean;
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

export function hasSandboxFlag(argv: string[]): boolean {
  return argv.some((arg) => isSandboxFlag(arg));
}

export function hasForegroundFlag(argv: string[]): boolean {
  return argv.some((arg) => isForegroundFlag(arg));
}

export function hasDebugFlag(argv: string[]): boolean {
  return argv.some((arg) => isDebugFlag(arg));
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
  return null;
}

export function parseGatewayFlags(argv: string[]): ParsedGatewayFlags {
  let debug = false;
  let foreground = false;
  let help = false;
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

  return { debug, foreground, help, sandboxMode };
}
