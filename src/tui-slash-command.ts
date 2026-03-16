import { mapCanonicalCommandToGatewayArgs } from './command-registry.js';

export interface ParsedTuiSlashCommand {
  cmd: string;
  parts: string[];
}

export type TuiApproveSlashResult =
  | { kind: 'usage' }
  | { kind: 'missing-approval' }
  | { kind: 'message'; message: string };

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
  const cmd = (parts[0] || '').trim().toLowerCase();
  if (cmd === 'skill') {
    const sub = (parts[1] || '').trim().toLowerCase();
    if (
      sub === 'list' ||
      sub === 'inspect' ||
      sub === 'amend' ||
      sub === 'history'
    ) {
      return ['skill', ...parts.slice(1)];
    }
    return null;
  }
  return mapCanonicalCommandToGatewayArgs(parts);
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
  if (action === 'session') {
    return { kind: 'message', message: `yes ${approvalId} for session` };
  }
  if (action === 'agent') {
    return { kind: 'message', message: `yes ${approvalId} for agent` };
  }
  if (action === 'no')
    return { kind: 'message', message: `skip ${approvalId}` };
  return { kind: 'usage' };
}
