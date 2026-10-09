/**
 * An approval answered as data (a card's button or `/approve`), not typed text.
 *
 * The agent still reads the runtime's reply text ("yes 1a2b3c4d"), built here
 * and nowhere else, but the stored user message is tagged
 * `APPROVAL_ANSWER_SOURCE`, so history leaves it out without guessing from
 * its words. NOT the policy that decides what an answer does
 * (`container/src/approval-policy.ts`) or the pending registry
 * (`pending-approvals.ts`).
 */

export const APPROVAL_ANSWER_SOURCE = 'approval';

export const APPROVAL_ANSWER_DECISIONS = [
  'yes',
  'session',
  'agent',
  'all',
  'no',
] as const;

export type ApprovalAnswerDecision = (typeof APPROVAL_ANSWER_DECISIONS)[number];

export interface GatewayApprovalAnswer {
  approvalId: string;
  decision: ApprovalAnswerDecision;
}

// Container approval ids are 8 hex characters; escalations use full UUIDs.
const APPROVAL_ID_RE = /^[a-f0-9-]{6,64}$/i;

/** Undefined when the body has no answer, null when it has a malformed one. */
export function parseApprovalAnswer(
  value: unknown,
): GatewayApprovalAnswer | null | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const approvalId =
    typeof raw.approvalId === 'string' ? raw.approvalId.trim() : '';
  const decision = APPROVAL_ANSWER_DECISIONS.find(
    (entry) => entry === raw.decision,
  );
  if (!APPROVAL_ID_RE.test(approvalId) || !decision) return null;
  return { approvalId, decision };
}

/** The reply text the container's approval policy reads for this answer. */
export function approvalAnswerText(answer: GatewayApprovalAnswer): string {
  const id = answer.approvalId.trim();
  const withId = (base: string) => (id ? `${base} ${id}` : base);
  if (answer.decision === 'yes' || answer.decision === 'no') {
    return withId(answer.decision);
  }
  return `${withId('yes')} for ${answer.decision}`;
}
