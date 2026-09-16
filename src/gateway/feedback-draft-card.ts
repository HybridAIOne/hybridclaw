/**
 * In-channel review card for feedback drafts: the buttons a channel renders
 * under an agent reply that queued a draft, and the mapping from a button
 * press back to the `/feedback` command that performs the action.
 */
import { REPORT_FEEDBACK_TOOL_NAME } from '../../container/shared/feedback-drafts.js';
import { getFeedbackDraft } from '../memory/db.js';
import type { ToolExecution } from '../types/execution.js';
import type {
  GatewayChatFeedbackDraft,
  GatewayMessageComponents,
} from './gateway-types.js';

export const FEEDBACK_DRAFT_ACTIONS = [
  'view',
  'send',
  'send-transcript',
  'discard',
] as const;
export type FeedbackDraftAction = (typeof FEEDBACK_DRAFT_ACTIONS)[number];

export const FEEDBACK_DRAFT_BUTTON_LABELS: Record<FeedbackDraftAction, string> =
  {
    view: 'View',
    send: 'Send',
    'send-transcript': 'Send + transcript',
    discard: 'Discard',
  };

const FEEDBACK_DRAFT_CUSTOM_ID_RE =
  /^feedback:(view|send|send-transcript|discard):(fbd_[0-9a-f]{10})$/;

export function buildFeedbackDraftCustomId(
  action: FeedbackDraftAction,
  draftId: string,
): string {
  return `feedback:${action}:${draftId}`;
}

export function parseFeedbackDraftCustomId(
  customId: string,
): { action: FeedbackDraftAction; draftId: string } | null {
  const match = customId.match(FEEDBACK_DRAFT_CUSTOM_ID_RE);
  if (!match) return null;
  return { action: match[1] as FeedbackDraftAction, draftId: match[2] };
}

export function isFeedbackDraftAction(
  value: string,
): value is FeedbackDraftAction {
  return (FEEDBACK_DRAFT_ACTIONS as readonly string[]).includes(value);
}

/** The `/feedback` command a button press stands for. */
export function feedbackDraftActionToCommandArgs(
  action: FeedbackDraftAction,
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

/** Discord-style raw component payload, mirroring approval-confirmation. */
export function buildFeedbackDraftComponents(
  draftId: string,
): GatewayMessageComponents {
  return [
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 2,
          label: FEEDBACK_DRAFT_BUTTON_LABELS.view,
          custom_id: buildFeedbackDraftCustomId('view', draftId),
        },
        {
          type: 2,
          style: 3,
          label: FEEDBACK_DRAFT_BUTTON_LABELS.send,
          custom_id: buildFeedbackDraftCustomId('send', draftId),
        },
        {
          type: 2,
          style: 1,
          label: FEEDBACK_DRAFT_BUTTON_LABELS['send-transcript'],
          custom_id: buildFeedbackDraftCustomId('send-transcript', draftId),
        },
        {
          type: 2,
          style: 4,
          label: FEEDBACK_DRAFT_BUTTON_LABELS.discard,
          custom_id: buildFeedbackDraftCustomId('discard', draftId),
        },
      ],
    },
  ];
}

const TYPE_LABEL: Record<GatewayChatFeedbackDraft['type'], string> = {
  bug: 'Bug report',
  idea: 'Idea',
  missing_capability: 'Missing capability',
};

export function formatFeedbackDraftCardText(
  draft: GatewayChatFeedbackDraft,
): string {
  return [
    `📝 **Feedback draft queued** · ${TYPE_LABEL[draft.type]}`,
    draft.title,
    `\`${draft.draftId}\` stays on this gateway until you send it. \`/feedback view ${draft.draftId}\` shows the full draft.`,
  ].join('\n');
}

interface ReportFeedbackToolOutput {
  success?: unknown;
  draftId?: unknown;
  deduplicated?: unknown;
}

/**
 * Drafts queued by this turn's `report_feedback` calls, resolved against the
 * store so the card shows the persisted (redacted) title.
 */
export function extractFeedbackDraftsFromToolExecutions(
  toolExecutions: readonly Pick<ToolExecution, 'name' | 'result'>[] | undefined,
): GatewayChatFeedbackDraft[] {
  if (!toolExecutions?.length) return [];
  const seen = new Set<string>();
  const drafts: GatewayChatFeedbackDraft[] = [];
  for (const execution of toolExecutions) {
    if (execution.name !== REPORT_FEEDBACK_TOOL_NAME) continue;
    let parsed: ReportFeedbackToolOutput;
    try {
      parsed = JSON.parse(execution.result) as ReportFeedbackToolOutput;
    } catch {
      continue;
    }
    if (parsed?.success !== true || parsed.deduplicated === true) continue;
    const draftId = typeof parsed.draftId === 'string' ? parsed.draftId : '';
    if (!draftId || seen.has(draftId)) continue;
    const record = getFeedbackDraft(draftId);
    if (record?.status !== 'queued') continue;
    seen.add(draftId);
    drafts.push({
      draftId: record.id,
      type: record.type,
      title: record.title,
      trigger: record.trigger,
    });
  }
  return drafts;
}
