/** Only transport-captured user text may answer an approval; null disables it. */
export interface ApprovalReplyContext {
  approvalUserText?: string | null;
  approvalUserId?: string;
  /** The turn came from another bot or a webhook, so nobody can answer. */
  approvalUserIsBot?: boolean;
  /** Host-validated connector decision; never accepted from a client payload. */
  approvalReplyDecision?: ApprovalReplyDecision;
}

/** An interpretation is not proof of execution; tool audit events record that. */
export interface ApprovalReplyInterpretation {
  decision: 'approve' | 'deny' | 'revise' | 'unclear' | 'unrelated' | 'error';
  approvalId: string | null;
  scope: 'once' | 'session' | 'agent' | 'all' | null;
  model?: string;
}

export interface ApprovalReplyDecision extends ApprovalReplyInterpretation {
  reply: string;
}
export declare const APPROVAL_REPLY_INSTRUCTIONS: string;
export declare function parseApprovalReplyDecision(
  content: string,
  pending: ReadonlyArray<{ id: string; pinned: boolean }>,
): ApprovalReplyDecision;
