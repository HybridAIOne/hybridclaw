/**
 * Admin review page for feedback drafts: lists what agents queued about
 * HybridClaw, filtered by status, and lets an operator view, send, or discard
 * queued drafts. Every action is the matching `/feedback` command sent through
 * `/api/command` for the draft's own session, so this page shares one
 * mutation path with the in-chat card.
 *
 * NOT the chat card (`chat/feedback-draft-card.tsx`), which reviews only the
 * drafts of the turn it sits under; and nothing here sends without a click.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useState } from 'react';
import { executeCommand } from '../api/chat';
import { fetchAdminFeedbackDrafts } from '../api/client';
import type {
  AdminCommandResult,
  AdminFeedbackDraft,
  AdminFeedbackDraftStatus,
} from '../api/types';
import { useAuth } from '../auth';
import { Button } from '../components/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/card';
import { TabbedPage } from '../components/tabbed-page';
import { useToast } from '../components/toast';
import { FEEDBACK_TABS } from '../lib/admin-tabs';
import { readStoredUserId } from '../lib/chat-helpers';
import { cx } from '../lib/cx';
import { getErrorMessage } from '../lib/error-message';
import {
  FEEDBACK_DRAFT_ACTION_LABEL,
  FEEDBACK_DRAFT_STATUS_LABEL,
  FEEDBACK_DRAFT_TYPE_LABEL,
  type FeedbackDraftReviewAction,
  feedbackDraftCommandArgs,
} from '../lib/feedback-drafts';
import { formatDateTime, formatRelativeTime } from '../lib/format';
import { logNavigationError } from '../lib/navigation';
import css from './feedback.module.css';
import { readRouteTab } from './tabbed-route';

type FeedbackTab = (typeof FEEDBACK_TABS)[number]['id'];

const TAB_STATUS: Record<FeedbackTab, AdminFeedbackDraftStatus> = {
  queued: 'queued',
  sent: 'submitted',
  discarded: 'discarded',
  expired: 'expired',
};

const EMPTY_COPY: Record<FeedbackTab, string> = {
  queued:
    'No queued feedback drafts. Agents file one when they hit a HybridClaw bug, a missing capability, or a mistake of their own.',
  sent: 'No feedback drafts have been sent yet.',
  discarded: 'No feedback drafts have been discarded.',
  expired:
    'No feedback drafts have expired. Unsent drafts expire after 30 days.',
};

const QUEUED_ACTIONS: ReadonlyArray<{
  action: FeedbackDraftReviewAction;
  variant: 'default' | 'outline' | 'danger';
}> = [
  { action: 'view', variant: 'outline' },
  { action: 'send', variant: 'default' },
  { action: 'send-transcript', variant: 'outline' },
  { action: 'discard', variant: 'danger' },
];

export function feedbackDraftsQueryKey(
  token: string,
  status: AdminFeedbackDraftStatus,
) {
  return ['admin-feedback-drafts', token, status] as const;
}

function metadataRows(
  draft: AdminFeedbackDraft,
): Array<{ label: string; value: string }> {
  const rows: Array<{ label: string; value: string | null }> = [
    { label: 'Draft ID', value: draft.id },
    { label: 'Trigger', value: draft.trigger },
    { label: 'Area', value: draft.area },
    { label: 'Failure mode', value: draft.failure_mode },
    { label: 'Task', value: draft.task_category },
    { label: 'Agent', value: draft.agent_id },
    { label: 'Channel', value: draft.channel_id },
    { label: 'Session', value: draft.session_id },
    { label: 'Run', value: draft.run_id },
    {
      label: 'Model',
      value: draft.model
        ? `${draft.model}${draft.provider ? ` (${draft.provider})` : ''}`
        : null,
    },
    { label: 'Gateway version', value: draft.gateway_version },
    { label: 'Created', value: formatDateTime(draft.created_at) },
    { label: 'Updated', value: formatDateTime(draft.updated_at) },
    { label: 'Expires', value: formatDateTime(draft.expires_at) },
    {
      label: 'Viewed',
      value: draft.viewed_at ? formatDateTime(draft.viewed_at) : 'Not yet',
    },
    { label: 'Submitted by', value: draft.submitted_by },
  ];
  return rows.filter((row): row is { label: string; value: string } =>
    Boolean(row.value),
  );
}

function FeedbackDraftRow(props: {
  draft: AdminFeedbackDraft;
  busyAction: FeedbackDraftReviewAction | null;
  lastResult: AdminCommandResult | null;
  onAction: (action: FeedbackDraftReviewAction) => void;
}) {
  const { draft } = props;
  const [expanded, setExpanded] = useState(false);
  const isQueued = draft.status === 'queued';

  return (
    <div className="list-row" data-testid={`feedback-draft-${draft.id}`}>
      <div>
        <strong>{draft.title}</strong>
        <small>
          {FEEDBACK_DRAFT_TYPE_LABEL[draft.type]}
          {draft.area ? ` · ${draft.area}` : ''}
          {draft.agent_id ? ` · agent ${draft.agent_id}` : ''}
          {draft.model ? ` · ${draft.model}` : ''}
          {` · ${formatRelativeTime(draft.created_at)}`}
          {` · ${FEEDBACK_DRAFT_STATUS_LABEL[draft.status]}`}
        </small>
        {expanded ? (
          <div className="detail-stack">
            <p className={cx('supporting-text', css.details)}>
              {draft.details}
            </p>
            <div className="key-value-grid">
              {metadataRows(draft).map((row) => (
                <div key={row.label}>
                  <span>{row.label}</span>
                  <strong>{row.value}</strong>
                </div>
              ))}
            </div>
          </div>
        ) : null}
        {props.lastResult ? (
          <p
            className={cx(
              'supporting-text',
              css.result,
              props.lastResult.kind === 'error' && css.resultError,
            )}
            role={props.lastResult.kind === 'error' ? 'alert' : 'status'}
          >
            {props.lastResult.text}
          </p>
        ) : null}
      </div>
      <div className="row-actions">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? 'Hide details' : 'Details'}
        </Button>
        {isQueued
          ? QUEUED_ACTIONS.map((btn) => (
              <Button
                key={btn.action}
                type="button"
                size="sm"
                variant={btn.variant}
                disabled={props.busyAction !== null}
                loading={props.busyAction === btn.action}
                onClick={() => props.onAction(btn.action)}
              >
                {FEEDBACK_DRAFT_ACTION_LABEL[btn.action]}
              </Button>
            ))
          : null}
      </div>
    </div>
  );
}

export function FeedbackPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const search = useSearch({ strict: false }) as { tab?: string };
  const activeTab = readRouteTab<FeedbackTab>(
    search.tab,
    FEEDBACK_TABS,
    'queued',
  );
  const status = TAB_STATUS[activeTab];
  const [lastResults, setLastResults] = useState<
    Record<string, AdminCommandResult>
  >({});

  const draftsQuery = useQuery({
    queryKey: feedbackDraftsQueryKey(auth.token, status),
    queryFn: () => fetchAdminFeedbackDrafts(auth.token, { status, limit: 100 }),
  });

  const actionMutation = useMutation({
    mutationFn: async (input: {
      draft: AdminFeedbackDraft;
      action: FeedbackDraftReviewAction;
    }) => {
      const result = await executeCommand(
        auth.token,
        input.draft.session_id,
        readStoredUserId(),
        feedbackDraftCommandArgs(input.action, input.draft.id),
      );
      return { ...input, result };
    },
    onSuccess: ({ draft, action, result }) => {
      setLastResults((prev) => ({ ...prev, [draft.id]: result }));
      if (result.kind === 'error') {
        toast.error(result.title || 'Feedback action failed', result.text);
        return;
      }
      if (action !== 'view') {
        toast.success(
          action === 'discard' ? 'Feedback draft discarded' : 'Feedback sent',
        );
      }
      void queryClient.invalidateQueries({
        queryKey: ['admin-feedback-drafts', auth.token],
      });
    },
    onError: (error, { draft }) => {
      const text = getErrorMessage(error);
      setLastResults((prev) => ({
        ...prev,
        [draft.id]: { kind: 'error', text },
      }));
      toast.error('Feedback action failed', text);
    },
  });

  const drafts = draftsQuery.data?.drafts ?? [];
  const busyDraftId = actionMutation.isPending
    ? actionMutation.variables?.draft.id
    : null;

  return (
    <TabbedPage
      tabs={FEEDBACK_TABS}
      activeTab={activeTab}
      description="Bug reports and ideas about HybridClaw that agents queued for review. Nothing is sent until you send it."
      onTabChange={(tab) => {
        void navigate({
          to: '/admin/feedback',
          search: { tab },
          replace: true,
        }).catch(logNavigationError);
      }}
    >
      <Card>
        <CardHeader>
          <CardTitle>
            {FEEDBACK_DRAFT_STATUS_LABEL[status]} drafts
            {draftsQuery.data ? ` (${drafts.length})` : ''}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {draftsQuery.isLoading ? (
            <div className="empty-state">Loading feedback drafts...</div>
          ) : draftsQuery.isError ? (
            <div className="empty-state error">
              {getErrorMessage(draftsQuery.error)}
            </div>
          ) : drafts.length === 0 ? (
            <div className="empty-state">{EMPTY_COPY[activeTab]}</div>
          ) : (
            <div className="list-stack">
              {drafts.map((draft) => (
                <FeedbackDraftRow
                  key={draft.id}
                  draft={draft}
                  busyAction={
                    busyDraftId === draft.id
                      ? (actionMutation.variables?.action ?? null)
                      : null
                  }
                  lastResult={lastResults[draft.id] ?? null}
                  onAction={(action) =>
                    actionMutation.mutate({ draft, action })
                  }
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </TabbedPage>
  );
}
