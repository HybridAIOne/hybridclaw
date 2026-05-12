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
  toolsMode: GatewayToolsMode | null;
  sandboxMode: SandboxModeOverride | null;
}

function normalizeArg(arg: string): string {
  return String(arg || '').trim();
}

function matchesFlag(arg: string, name: string): boolean {
  const normalized = normalizeArg(arg);
  return normalized === `--${name}` || normalized.startsWith(`--${name}=`);
}

function matchesExactFlag(arg: string, name: string): boolean {
  return normalizeArg(arg) === `--${name}`;
}

function hasFlag(argv: string[], name: string): boolean {
  return argv.some((arg) => matchesFlag(arg, name));
}

function hasExactFlag(argv: string[], name: string): boolean {
  return argv.some((arg) => matchesExactFlag(arg, name));
}

function hasShortFlag(argv: string[], name: string): boolean {
  return argv.some((arg) => normalizeArg(arg) === `-${name}`);
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

export function findUnsupportedGatewayLifecycleFlag(
  argv: string[],
): UnsupportedGatewayLifecycleFlag | null {
  if (argv.length === 0) return null;

  const sub = String(argv[0] || '')
    .trim()
    .toLowerCase();
  if (sub === 'start' || sub === 'restart') return null;
  if (hasFlag(argv, 'sandbox')) return 'sandbox';
  if (hasFlag(argv, 'foreground') || hasShortFlag(argv, 'f')) {
    return 'foreground';
  }
  if (hasExactFlag(argv, 'debug')) return 'debug';
  if (hasExactFlag(argv, 'log-requests')) return 'log-requests';
  if (hasExactFlag(argv, 'debug-model-responses')) {
    return 'debug-model-responses';
  }
  if (hasFlag(argv, 'system-prompt')) return 'system-prompt';
  if (hasFlag(argv, 'tools')) return 'tools';
  if (hasExactFlag(argv, 'no-tools')) return 'no-tools';
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
  let toolsMode: GatewayToolsMode | null = null;
  let sandboxMode: SandboxModeOverride | null = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = normalizeArg(argv[i] || '');
    if (!arg) continue;

    if (matchesExactFlag(arg, 'foreground') || arg === '-f') {
      foreground = true;
      continue;
    }

    if (matchesExactFlag(arg, 'debug')) {
      debug = true;
      continue;
    }

    if (matchesExactFlag(arg, 'log-requests')) {
      logRequests = true;
      continue;
    }

    if (matchesExactFlag(arg, 'debug-model-responses')) {
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

    if (matchesFlag(arg, 'sandbox')) {
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

    if (matchesFlag(arg, 'system-prompt')) {
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

    if (matchesFlag(arg, 'tools')) {
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

    if (matchesExactFlag(arg, 'no-tools')) {
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
    toolsMode,
    sandboxMode,
  };
}
