export const APPROVAL_MODES: readonly ['ask', 'auto', 'full'];

export type ApprovalMode = (typeof APPROVAL_MODES)[number];

export const DEFAULT_APPROVAL_MODE: ApprovalMode;

export const APPROVAL_MODE_PRESENTATION: Readonly<
  Record<ApprovalMode, { label: string; description: string }>
>;

export function isApprovalMode(value: unknown): value is ApprovalMode;
