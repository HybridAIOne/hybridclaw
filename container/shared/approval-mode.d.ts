export const APPROVAL_MODES: readonly ['ask', 'auto', 'full', 'learning'];

export type ApprovalMode = (typeof APPROVAL_MODES)[number];

export const DEFAULT_APPROVAL_MODE: ApprovalMode;

export const APPROVAL_MODE_PRESENTATION: Readonly<
  Record<ApprovalMode, { label: string; description: string }>
>;

export function isApprovalMode(value: unknown): value is ApprovalMode;

/** The normal auto-mode decision observed without asking or granting trust. */
export interface ApprovalObservation {
  decision: 'required' | 'implicit';
  tier: 'green' | 'yellow' | 'red';
  pinned: boolean;
  reason: string;
}
