import {
  APPROVAL_SCOPE_MODES,
  type ApprovalScopeMode,
} from './approval-commands.js';
import { mapCanonicalCommandToGatewayArgs } from './command-registry.js';

export interface ParsedTuiSlashCommand {
  cmd: string;
  parts: string[];
}

export type TuiApproveSlashResult =
  | { kind: 'usage' }
  | { kind: 'missing-approval' }
  | { kind: 'message'; message: string };

function isApprovalScopeMode(value: string): value is ApprovalScopeMode {
  return APPROVAL_SCOPE_MODES.includes(value as ApprovalScopeMode);
}

function tokenizeTuiSlashInput(raw: string): string[] {
  return raw.match(/"[^"]*"|\S+/g) ?? [];
}

export function parseTuiSlashCommand(input: string): ParsedTuiSlashCommand {
  const raw = input.startsWith('/') ? input.slice(1).trim() : input.trim();
  if (!raw) return { cmd: '', parts: [] };

  const tokens = tokenizeTuiSlashInput(raw);
  const cmd = (tokens[0] || '').toLowerCase();
  if (!cmd) return { cmd: '', parts: [] };

  if (cmd !== 'mcp') {
    return { cmd, parts: tokens };
  }

  const sub = (tokens[1] || '').toLowerCase();
  if (sub !== 'add') {
    return { cmd, parts: tokens };
  }

  const addMatch = raw.match(/^mcp\s+add\s+(\S+)\s+([\s\S]+)$/i);
  if (!addMatch) {
    return { cmd, parts: tokens };
  }

  const [, name, jsonPayload] = addMatch;
  return {
    cmd,
    parts: ['mcp', 'add', name, jsonPayload.trim()],
  };
}

export function mapTuiSlashCommandToGatewayArgs(
  parts: string[],
  options?: {
    dynamicTextCommands?: Iterable<string>;
  },
): string[] | null {
  const cmd = (parts[0] || '').trim().toLowerCase();
  if (cmd === 'export') {
    const sub = (parts[1] || '').trim().toLowerCase();
    if (sub === 'session') return ['export', 'session', ...parts.slice(2)];
    if (sub === 'trace') return ['export', 'trace', ...parts.slice(2)];
    return null;
  }
  if (cmd === 'skill') {
    const sub = (parts[1] || '').trim().toLowerCase();
    if (
      sub === 'list' ||
      sub === 'enable' ||
      sub === 'disable' ||
      sub === 'inspect' ||
      sub === 'runs' ||
      sub === 'install' ||
      sub === 'setup' ||
      sub === 'learn' ||
      sub === 'history' ||
      sub === 'sync' ||
      sub === 'import'
    ) {
      return ['skill', ...parts.slice(1)];
    }
    return null;
  }
  if (cmd === 'eval') {
    return ['eval', ...parts.slice(1)];
  }
  return mapCanonicalCommandToGatewayArgs(parts, options);
}

export function mapTuiApproveSlashToMessage(
  parts: string[],
  pendingApprovalId?: string | null,
): TuiApproveSlashResult {
  const action = (parts[1] || 'view').trim().toLowerCase();
  const approvalId = (parts[2] || pendingApprovalId || '').trim();
  if (!approvalId) return { kind: 'missing-approval' };
  if (action === 'yes')
    return { kind: 'message', message: `yes ${approvalId}` };
  if (isApprovalScopeMode(action) && action !== 'once') {
    return { kind: 'message', message: `yes ${approvalId} for ${action}` };
  }
  if (action === 'no')
    return { kind: 'message', message: `skip ${approvalId}` };
  return { kind: 'usage' };
}
