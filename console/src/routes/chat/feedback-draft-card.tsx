/**
 * In-chat review card for one feedback draft the agent queued this turn.
 * Owns only its own transient review state (busy, viewed text, outcome); the
 * draft itself lives in the gateway DB and every button is just the matching
 * `/feedback` command sent through `/api/command`, so this card and the
 * `/admin/feedback` page can never disagree on what an action does.
 *
 * NOT an approval card: nothing here blocks the agent, and nothing leaves the
 * gateway until the operator presses Send.
 */
import { useState } from 'react';
import { executeCommand } from '../../api/chat';
import type { ChatFeedbackDraft } from '../../api/chat-types';
import { Button } from '../../components/button';
import { readStoredUserId } from '../../lib/chat-helpers';
import { cx } from '../../lib/cx';
import { getErrorMessage } from '../../lib/error-message';
import {
  FEEDBACK_DRAFT_ACTION_LABEL,
  FEEDBACK_DRAFT_STATUS_LABEL,
  FEEDBACK_DRAFT_TYPE_LABEL,
  type FeedbackDraftReviewAction,
  feedbackDraftCommandArgs,
  feedbackDraftStatusAfter,
} from '../../lib/feedback-drafts';
import { renderMarkdown } from '../../lib/markdown';
import css from './chat-page.module.css';

type ReviewOutcome = {
  status: 'submitted' | 'discarded';
  text: string;
};

const REVIEW_BUTTONS: ReadonlyArray<{
  action: FeedbackDraftReviewAction;
  variant: 'default' | 'outline' | 'danger';
}> = [
  { action: 'view', variant: 'outline' },
  { action: 'send', variant: 'default' },
  { action: 'send-transcript', variant: 'outline' },
  { action: 'discard', variant: 'danger' },
];

export function FeedbackDraftCard(props: {
  draft: ChatFeedbackDraft;
  sessionId: string;
  token: string;
}) {
  const { draft, sessionId, token } = props;
  const [busyAction, setBusyAction] =
    useState<FeedbackDraftReviewAction | null>(null);
  const [viewHtml, setViewHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<ReviewOutcome | null>(null);

  const runAction = async (action: FeedbackDraftReviewAction) => {
    setBusyAction(action);
    setError(null);
    try {
      const result = await executeCommand(
        token,
        sessionId,
        readStoredUserId(),
        feedbackDraftCommandArgs(action, draft.draftId),
      );
      if (result.kind === 'error') {
        setError(result.text);
        return;
      }
      if (action === 'view') {
        setViewHtml(renderMarkdown(result.text, { highlight: false }));
        return;
      }
      const status = feedbackDraftStatusAfter(action);
      if (status) setOutcome({ status, text: result.text });
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <div
      className={cx(
        css.feedbackCard,
        outcome && css.feedbackCardResolved,
        outcome?.status === 'discarded' && css.feedbackCardDiscarded,
      )}
      data-testid="feedback-draft-card"
    >
      <div className={css.feedbackHeader}>
        <span className={css.feedbackTitle}>Feedback draft queued</span>
        <span className={css.feedbackType}>
          {FEEDBACK_DRAFT_TYPE_LABEL[draft.type]}
        </span>
        {outcome ? (
          <span
            className={cx(
              css.feedbackStatus,
              outcome.status === 'submitted' && css.feedbackStatusSent,
            )}
          >
            {FEEDBACK_DRAFT_STATUS_LABEL[outcome.status]}
          </span>
        ) : null}
      </div>
      <p className={css.feedbackDraftTitle}>{draft.title}</p>
      {viewHtml ? (
        <div
          className={cx(css.markdownContent, css.feedbackView)}
          // biome-ignore lint/security/noDangerouslySetInnerHtml: command output is rendered by marked and sanitized through sanitize-html
          dangerouslySetInnerHTML={{ __html: viewHtml }}
        />
      ) : null}
      {outcome ? (
        <p className={css.feedbackResult}>{outcome.text}</p>
      ) : (
        <>
          <p className={css.feedbackNote}>
            Stays on this gateway until you send it.
          </p>
          <div className={css.feedbackActions}>
            {REVIEW_BUTTONS.map((btn) => (
              <Button
                key={btn.action}
                size="sm"
                variant={btn.variant}
                disabled={busyAction !== null}
                loading={busyAction === btn.action}
                onClick={() => void runAction(btn.action)}
              >
                {FEEDBACK_DRAFT_ACTION_LABEL[btn.action]}
              </Button>
            ))}
          </div>
        </>
      )}
      {error ? (
        <p className={css.feedbackError} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
