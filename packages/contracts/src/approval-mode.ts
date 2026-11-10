/**
 * Approval mode — how eager a session is to act without asking.
 *
 * `ask` prompts for every side effect, `auto` lets the traffic-light pipeline
 * decide, `full` auto-approves yellow and eligible red. `learning` records prompts
 * and notices while allowing them, including pinned approvals; unconditional
 * denials remain enforced. NOT `/approve`, which answers one prompt, and NOT
 * the normalizer and labels (`packages/shared/src/approval-mode.ts`).
 */
export const APPROVAL_MODES = ['ask', 'auto', 'full', 'learning'] as const;

export type ApprovalMode = (typeof APPROVAL_MODES)[number];

/** The normal auto-mode decision observed without asking or granting trust. */
export interface ApprovalObservation {
  decision: 'required' | 'implicit';
  tier: 'green' | 'yellow' | 'red';
  pinned: boolean;
  reason: string;
}
