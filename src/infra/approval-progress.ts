/**
 * Shared host/container IPC approval decoder. Retains the pending call's review
 * facts for the authenticated client; never logs them or changes grant scope.
 * Review arguments are projected at the producer, separately from diagnostic prose.
 */
import { redactCredentialSecrets } from '../security/redact.js';
import {
  normalizeEscalationTarget,
  type PendingApproval,
} from '../types/execution.js';

const APPROVAL_RE = /^\[approval\]\s+([A-Za-z0-9+/=]+)$/;

export function parseApprovalProgress(line: string): PendingApproval | null {
  const match = line.match(APPROVAL_RE);
  if (!match) return null;
  try {
    const raw = Buffer.from(match[1], 'base64').toString('utf-8');
    const parsed = JSON.parse(raw) as Partial<PendingApproval> & {
      escalationTarget?: unknown;
    };
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof parsed.approvalId !== 'string' ||
      typeof parsed.prompt !== 'string' ||
      typeof parsed.intent !== 'string' ||
      typeof parsed.reason !== 'string'
    ) {
      return null;
    }
    const escalationTarget = normalizeEscalationTarget(parsed.escalationTarget);
    return {
      approvalId: parsed.approvalId,
      prompt: redactCredentialSecrets(parsed.prompt),
      intent: redactCredentialSecrets(parsed.intent),
      reason: redactCredentialSecrets(parsed.reason),
      ...(typeof parsed.toolName === 'string'
        ? { toolName: parsed.toolName }
        : {}),
      ...(typeof parsed.commandPreview === 'string'
        ? { commandPreview: redactCredentialSecrets(parsed.commandPreview) }
        : {}),
      ...(typeof parsed.reviewArguments === 'string' &&
      Buffer.byteLength(parsed.reviewArguments, 'utf8') <= 262_144
        ? { reviewArguments: parsed.reviewArguments }
        : {}),
      allowSession: parsed.allowSession === true,
      allowAgent: parsed.allowAgent === true,
      allowAll: parsed.allowAll === true,
      expiresAt:
        typeof parsed.expiresAt === 'number' &&
        Number.isFinite(parsed.expiresAt)
          ? parsed.expiresAt
          : null,
      ...(escalationTarget ? { escalationTarget } : {}),
    };
  } catch {
    return null;
  }
}
