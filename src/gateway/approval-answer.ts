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
  // Not sent: the same turn saves the email in the mailbox drafts.
  'draft',
] as const;

export type ApprovalAnswerDecision = (typeof APPROVAL_ANSWER_DECISIONS)[number];

export interface GatewayApprovalAnswer {
  approvalId: string;
  decision: ApprovalAnswerDecision;
  // `draft` only: the user's version of the email they reviewed.
  email?: DraftEmail;
}

export interface DraftEmail {
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  body?: string;
}

const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string');

/** Undefined when absent, null when malformed; unknown fields are dropped. */
function parseDraftEmail(value: unknown): DraftEmail | null | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const email: DraftEmail = {};
  for (const key of ['to', 'cc', 'bcc'] as const) {
    if (raw[key] === undefined) continue;
    if (!isStrings(raw[key])) return null;
    email[key] = raw[key];
  }
  for (const key of ['subject', 'body'] as const) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== 'string') return null;
    email[key] = raw[key];
  }
  return email;
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
  const email = decision === 'draft' ? parseDraftEmail(raw.email) : undefined;
  if (email === null) return null;
  return { approvalId, decision, ...(email ? { email } : {}) };
}

/** The reply text the container's approval policy reads for this answer. */
export function approvalAnswerText(answer: GatewayApprovalAnswer): string {
  const id = answer.approvalId.trim();
  const withId = (base: string) => (id ? `${base} ${id}` : base);
  if (answer.decision === 'draft') {
    return answer.email
      ? `${withId('draft')}\n${JSON.stringify(answer.email)}`
      : withId('draft');
  }
  if (answer.decision === 'yes' || answer.decision === 'no') {
    return withId(answer.decision);
  }
  return `${withId('yes')} for ${answer.decision}`;
}
