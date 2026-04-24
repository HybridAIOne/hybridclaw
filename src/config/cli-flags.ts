import type { PromptMode } from '../agent/prompt-hooks.js';
import {
  type PromptPartName,
  parsePromptPartList,
} from '../agent/prompt-parts.js';

export type SandboxModeOverride = 'container' | 'host';
export type GatewayToolsMode = 'full' | 'none';
export type UnsupportedGatewayLifecycleFlag =
  | 'foreground'
  | 'sandbox'
  | 'debug'
  | 'log-requests'
  | 'debug-model-responses'
  | 'system-prompt'
  | 'system-prompt-exclude'
  | 'tools'
  | 'no-tools';

export interface ParsedGatewayFlags {
  debug: boolean;
  debugModelResponses: boolean;
  foreground: boolean;
  help: boolean;
  logRequests: boolean;
  systemPromptMode: PromptMode | null;
  systemPromptParts: PromptPartName[];
  systemPromptExcludeParts: PromptPartName[];
  toolsMode: GatewayToolsMode | null;
  sandboxMode: SandboxModeOverride | null;
}

function normalizeSandboxMode(value: string): SandboxModeOverride | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'container') return 'container';
  if (normalized === 'host') return 'host';
  return null;
}

function normalizeSystemPromptMode(value: string): PromptMode | null {
  const normalized = value.trim().toLowerCase();
  if (
    normalized === 'full' ||
    normalized === 'minimal' ||
    normalized === 'none'
  ) {
    return normalized;
  }
  return null;
}

function normalizeGatewayToolsMode(value: string): GatewayToolsMode | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'full' || normalized === 'none') return normalized;
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

function isSystemPromptFlag(arg: string): boolean {
  const normalized = String(arg || '').trim();
  return (
    normalized === '--system-prompt' ||
    normalized.startsWith('--system-prompt=')
  );
}

function isSystemPromptExcludeFlag(arg: string): boolean {
  const normalized = String(arg || '').trim();
  return (
    normalized === '--system-prompt-exclude' ||
    normalized.startsWith('--system-prompt-exclude=')
  );
}

function isToolsFlag(arg: string): boolean {
  const normalized = String(arg || '').trim();
  return normalized === '--tools' || normalized.startsWith('--tools=');
}

function isNoToolsFlag(arg: string): boolean {
  return String(arg || '').trim() === '--no-tools';
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

function hasSystemPromptFlag(argv: string[]): boolean {
  return argv.some((arg) => isSystemPromptFlag(arg));
}

function hasSystemPromptExcludeFlag(argv: string[]): boolean {
  return argv.some((arg) => isSystemPromptExcludeFlag(arg));
}

function hasToolsFlag(argv: string[]): boolean {
  return argv.some((arg) => isToolsFlag(arg));
}

function hasNoToolsFlag(argv: string[]): boolean {
  return argv.some((arg) => isNoToolsFlag(arg));
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
  if (hasSystemPromptFlag(argv)) return 'system-prompt';
  if (hasSystemPromptExcludeFlag(argv)) return 'system-prompt-exclude';
  if (hasToolsFlag(argv)) return 'tools';
  if (hasNoToolsFlag(argv)) return 'no-tools';
  return null;
}

export function parseGatewayFlags(argv: string[]): ParsedGatewayFlags {
  let debug = false;
  let debugModelResponses = false;
  let foreground = false;
  let help = false;
  let logRequests = false;
  let systemPromptMode: PromptMode | null = null;
  let systemPromptParts: PromptPartName[] = [];
  let systemPromptExcludeParts: PromptPartName[] = [];
  let toolsMode: GatewayToolsMode | null = null;
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

    if (arg === '--system-prompt') {
      const next = String(argv[i + 1] || '').trim();
      const promptMode = normalizeSystemPromptMode(next);
      if (promptMode) {
        systemPromptMode = promptMode;
        systemPromptParts = [];
      } else {
        systemPromptMode = null;
        systemPromptParts = parsePromptPartList(next, '--system-prompt');
      }
      i += 1;
      continue;
    }

    if (arg.startsWith('--system-prompt=')) {
      const raw = arg.slice('--system-prompt='.length);
      const promptMode = normalizeSystemPromptMode(raw);
      if (promptMode) {
        systemPromptMode = promptMode;
        systemPromptParts = [];
      } else {
        systemPromptMode = null;
        systemPromptParts = parsePromptPartList(raw, '--system-prompt');
      }
      continue;
    }

    if (arg === '--system-prompt-exclude') {
      const next = String(argv[i + 1] || '').trim();
      systemPromptExcludeParts = parsePromptPartList(
        next,
        '--system-prompt-exclude',
      );
      i += 1;
      continue;
    }

    if (arg.startsWith('--system-prompt-exclude=')) {
      systemPromptExcludeParts = parsePromptPartList(
        arg.slice('--system-prompt-exclude='.length),
        '--system-prompt-exclude',
      );
      continue;
    }

    if (arg === '--tools') {
      const next = String(argv[i + 1] || '').trim();
      const parsed = normalizeGatewayToolsMode(next);
      if (!parsed) {
        throw new Error(
          `Invalid value for --tools: ${next || '<missing>'}. Use --tools=full or --tools=none.`,
        );
      }
      toolsMode = parsed;
      i += 1;
      continue;
    }

    if (arg.startsWith('--tools=')) {
      const raw = arg.slice('--tools='.length);
      const parsed = normalizeGatewayToolsMode(raw);
      if (!parsed) {
        throw new Error(
          `Invalid value for --tools: ${raw || '<missing>'}. Use --tools=full or --tools=none.`,
        );
      }
      toolsMode = parsed;
      continue;
    }

    if (arg === '--no-tools') {
      toolsMode = 'none';
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
    systemPromptMode,
    systemPromptParts,
    systemPromptExcludeParts,
    toolsMode,
    sandboxMode,
  };
}
