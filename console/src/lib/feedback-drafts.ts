/**
 * Shared vocabulary for feedback-draft review surfaces (chat card, admin
 * page): human labels and the exact `/feedback` command each button stands
 * for. Both surfaces must agree on these args because the gateway command
 * endpoint is the only mutation path — there is no dedicated REST action.
 *
 * NOT a data store or fetcher; it never talks to the gateway.
 */

export type FeedbackDraftReviewAction =
  | 'view'
  | 'send'
  | 'send-transcript'
  | 'discard';

export type FeedbackDraftKind = 'bug' | 'idea' | 'missing_capability';

export type FeedbackDraftReviewStatus =
  | 'queued'
  | 'submitted'
  | 'discarded'
  | 'expired';

export const FEEDBACK_DRAFT_TYPE_LABEL: Record<FeedbackDraftKind, string> = {
  bug: 'Bug report',
  idea: 'Idea',
  missing_capability: 'Missing capability',
};

export const FEEDBACK_DRAFT_STATUS_LABEL: Record<
  FeedbackDraftReviewStatus,
  string
> = {
  queued: 'Queued',
  submitted: 'Sent',
  discarded: 'Discarded',
  expired: 'Expired',
};

export const FEEDBACK_DRAFT_ACTION_LABEL: Record<
  FeedbackDraftReviewAction,
  string
> = {
  view: 'View',
  send: 'Send',
  'send-transcript': 'Send with transcript',
  discard: 'Discard',
};

/** The `/feedback` command args a review button runs through `/api/command`. */
export function feedbackDraftCommandArgs(
  action: FeedbackDraftReviewAction,
  draftId: string,
): string[] {
  switch (action) {
    case 'view':
      return ['feedback', 'view', draftId];
    case 'send':
      return ['feedback', 'send', draftId];
    case 'send-transcript':
      return ['feedback', 'send', draftId, '--transcript'];
    case 'discard':
      return ['feedback', 'discard', draftId];
  }
}

/** Terminal status a successful send/discard leaves the draft in. */
export function feedbackDraftStatusAfter(
  action: FeedbackDraftReviewAction,
): Exclude<FeedbackDraftReviewStatus, 'queued' | 'expired'> | null {
  if (action === 'send' || action === 'send-transcript') return 'submitted';
  if (action === 'discard') return 'discarded';
  return null;
}
