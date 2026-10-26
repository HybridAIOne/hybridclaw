/**
 * Parses the existing command wire format used by approval buttons and CLIs.
 * Natural language is interpreted by approval-reply, never by this parser.
 */
import type { ApprovalPrelude } from './approval-policy.js';

type ApprovalMode = NonNullable<ApprovalPrelude['approvalMode']>;
export interface ApprovalDirective {
  kind: 'approve' | 'deny' | 'draft';
  mode?: ApprovalMode;
  requestId: string;
  // `draft`: the user's own version of the email, data for the prompt only.
  email?: Record<string, unknown>;
}
// `draft <id>`, optionally followed by the user's version as JSON on its own lines.
const DRAFT_RE = /^draft\s+([a-f0-9-]{6,64})(?:\s*\n([\s\S]+))?$/i;
const APPROVE_RE =
  /^(?:\/?(?:approve|yes|y))(?:\s+([a-f0-9-]{6,64}))?(?:\s+(for\s+session|session|for\s+all|all|for\s+agent|agent))?$/i;
const DENY_RE = /^(?:\/?(?:deny|reject|skip|no|n))(?:\s+([a-f0-9-]{6,64}))?$/i;
function parseModeFromApproveMatch(
  match: RegExpMatchArray | null,
): ApprovalMode {
  const scope = String(match?.[2] || '').toLowerCase();
  if (scope.includes('all')) return 'all';
  if (scope.includes('agent')) return 'agent';
  if (scope.includes('session')) return 'session';
  return 'once';
}

function draftEmail(json: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(json);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value
      : null;
  } catch {
    return null;
  }
}

export function parseApprovalDirective(
  input: string,
): ApprovalDirective | null {
  const normalized = input.trim();
  if (!normalized) return null;

  const directiveCandidates = [
    normalized,
    normalized.replace(/^(?:<@!?\d+>\s*)+/, ''),
  ];

  for (const candidate of directiveCandidates) {
    if (!candidate) continue;
    const draftMatch = candidate.match(DRAFT_RE);
    if (draftMatch) {
      const email = draftMatch[2] ? draftEmail(draftMatch[2]) : undefined;
      if (email === null) return null;
      return {
        kind: 'draft',
        requestId: draftMatch[1],
        ...(email ? { email } : {}),
      };
    }
    const approveMatch = candidate.match(APPROVE_RE);
    if (approveMatch) {
      return {
        kind: 'approve',
        mode: parseModeFromApproveMatch(approveMatch),
        requestId: String(approveMatch[1] || '').trim(),
      };
    }

    const denyMatch = candidate.match(DENY_RE);
    if (denyMatch) {
      return {
        kind: 'deny',
        requestId: String(denyMatch[1] || '').trim(),
      };
    }
  }

  return null;
}

export function parseApprovalUserResponse(
  input: string,
): ApprovalDirective | null {
  const normalized = input.trim();
  if (!normalized) return null;

  const candidates: string[] = [];
  const pushCandidate = (value: string): void => {
    const trimmed = value.trim();
    if (!trimmed) return;
    if (candidates.includes(trimmed)) return;
    candidates.push(trimmed);
  };

  pushCandidate(normalized);
  pushCandidate(normalized.replace(/^(?:<@!?\d+>\s*)+/, ''));

  const batchTailMatch = normalized.match(/Message\s+\d+\s*:\s*([\s\S]+)$/i);
  if (batchTailMatch?.[1]) {
    pushCandidate(batchTailMatch[1]);
  }

  const lines = normalized
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length > 0) {
    pushCandidate(lines[lines.length - 1]);
  }

  for (const candidate of candidates) {
    const parsed = parseApprovalDirective(candidate);
    if (parsed) return parsed;
  }
  return null;
}
