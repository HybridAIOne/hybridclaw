import { mapCanonicalCommandToGatewayArgs } from './command-registry.js';

export interface ParsedTuiSlashCommand {
  cmd: string;
  parts: string[];
}

export type TuiApproveSlashResult =
  | { kind: 'usage' }
  | { kind: 'missing-approval' }
  | { kind: 'args'; args: string[] };

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
): string[] | null {
  return mapCanonicalCommandToGatewayArgs(parts);
}

export function mapTuiApproveSlashToGatewayArgs(
  parts: string[],
  pendingApprovalId?: string | null,
): TuiApproveSlashResult {
  const action = (parts[1] || 'view').trim().toLowerCase();
  const approvalId = (parts[2] || pendingApprovalId || '').trim();
  if (!approvalId) return { kind: 'missing-approval' };
  if (action === 'yes')
    return { kind: 'args', args: ['approve', 'yes', approvalId] };
  if (action === 'session') {
    return { kind: 'args', args: ['approve', 'session', approvalId] };
  }
  if (action === 'agent') {
    return { kind: 'args', args: ['approve', 'agent', approvalId] };
  }
  if (action === 'no')
    return { kind: 'args', args: ['approve', 'no', approvalId] };
  return { kind: 'usage' };
}
