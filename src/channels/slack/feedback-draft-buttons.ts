import {
  FEEDBACK_DRAFT_BUTTON_LABELS,
  type FeedbackDraftAction,
  isFeedbackDraftAction,
} from '../../gateway/feedback-draft-card.js';
import type { SlackApprovalBlock } from './approval-buttons.js';

const SLACK_FEEDBACK_ACTION_ID_RE =
  /^feedback:(view|send|send-transcript|discard)$/;
const FEEDBACK_DRAFT_ID_RE = /^fbd_[0-9a-f]{10}$/;

function buildButton(params: {
  action: FeedbackDraftAction;
  draftId: string;
  style?: 'primary' | 'danger';
}) {
  return {
    type: 'button' as const,
    text: {
      type: 'plain_text' as const,
      text: FEEDBACK_DRAFT_BUTTON_LABELS[params.action],
      emoji: true,
    },
    action_id: `feedback:${params.action}`,
    value: params.draftId,
    ...(params.style ? { style: params.style } : {}),
  };
}

export function buildSlackFeedbackDraftBlocks(
  text: string,
  draftId: string,
): SlackApprovalBlock[] {
  return [
    { type: 'section', text: { type: 'mrkdwn', text } },
    {
      type: 'actions',
      elements: [
        buildButton({ action: 'view', draftId }),
        buildButton({ action: 'send', draftId, style: 'primary' }),
        buildButton({ action: 'send-transcript', draftId }),
        buildButton({ action: 'discard', draftId, style: 'danger' }),
      ],
    },
  ];
}

export function parseSlackFeedbackDraftAction(
  actionId: string,
  draftId: string,
): { action: FeedbackDraftAction; draftId: string } | null {
  const match = actionId.match(SLACK_FEEDBACK_ACTION_ID_RE);
  if (!match) return null;
  const action = match[1];
  if (!isFeedbackDraftAction(action)) return null;
  if (!FEEDBACK_DRAFT_ID_RE.test(draftId)) return null;
  return { action, draftId };
}
