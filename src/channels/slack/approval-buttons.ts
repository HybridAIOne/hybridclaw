import { APPROVAL_BUTTON_LABELS } from '../../gateway/approval-button-labels.js';

type SlackTextObject =
  | { type: 'plain_text'; text: string; emoji?: boolean }
  | { type: 'mrkdwn'; text: string };

type SlackButtonElement = {
  type: 'button';
  text: { type: 'plain_text'; text: string; emoji?: boolean };
  action_id: string;
  value: string;
  style?: 'primary' | 'danger';
};

type SlackSectionBlock = {
  type: 'section';
  text: { type: 'mrkdwn'; text: string };
};

type SlackActionsBlock = {
  type: 'actions';
  elements: SlackButtonElement[];
};

type SlackContextBlock = {
  type: 'context';
  elements: SlackTextObject[];
};

export type SlackApprovalBlock =
  | SlackSectionBlock
  | SlackActionsBlock
  | SlackContextBlock;

const SLACK_APPROVAL_ACTION_ID_RE = /^approve:(yes|session|agent|all|no)$/;

function buildApprovalButton(params: {
  actionId: string;
  approvalId: string;
  label: string;
  style?: 'primary' | 'danger';
}): SlackButtonElement {
  return {
    type: 'button',
    text: {
      type: 'plain_text',
      text: params.label,
      emoji: true,
    },
    action_id: params.actionId,
    value: params.approvalId,
    ...(params.style ? { style: params.style } : {}),
  };
}

export function buildSlackApprovalBlocks(
  promptText: string,
  approvalId: string,
  options?: { showButtons?: boolean },
): SlackApprovalBlock[] {
  const blocks: SlackApprovalBlock[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: promptText,
      },
    },
  ];
  if (options?.showButtons === false) {
    return blocks;
  }
  blocks.push({
    type: 'actions',
    elements: [
      buildApprovalButton({
        actionId: 'approve:yes',
        approvalId,
        label: APPROVAL_BUTTON_LABELS.yes,
        style: 'primary',
      }),
      buildApprovalButton({
        actionId: 'approve:session',
        approvalId,
        label: APPROVAL_BUTTON_LABELS.session,
      }),
      buildApprovalButton({
        actionId: 'approve:agent',
        approvalId,
        label: APPROVAL_BUTTON_LABELS.agent,
      }),
      buildApprovalButton({
        actionId: 'approve:all',
        approvalId,
        label: APPROVAL_BUTTON_LABELS.all,
      }),
      buildApprovalButton({
        actionId: 'approve:no',
        approvalId,
        label: APPROVAL_BUTTON_LABELS.no,
        style: 'danger',
      }),
    ],
  });
  return blocks;
}

export function buildSlackResolvedApprovalBlocks(
  promptText: string,
  statusText: string,
): SlackApprovalBlock[] {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: promptText,
      },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: statusText,
        },
      ],
    },
  ];
}

export function parseSlackApprovalAction(
  actionId: string,
  approvalId: string,
): { action: string; approvalId: string } | null {
  const match = actionId.trim().match(SLACK_APPROVAL_ACTION_ID_RE);
  const normalizedApprovalId = approvalId.trim();
  if (!match || !normalizedApprovalId) {
    return null;
  }
  const [, action] = match;
  return {
    action,
    approvalId: normalizedApprovalId,
  };
}
