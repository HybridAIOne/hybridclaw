/**
 * The email draft a turn showed the user, read from its `draft_email` call
 * (`container/src/tools/draft-email.ts`), never from the reply text.
 *
 * The stored reply gets the draft as plain text too, so channels without the
 * card, the web chat and later turns see it; `reply` keeps what the agent
 * wrote, which the apps show above the card.
 */
import {
  type EmailDraft,
  emailDraftText,
  type MessageEmailDraft,
  normalizeEmailDraft,
} from '../../container/shared/email-draft.js';
import type { ToolExecution } from '../types/execution.js';

/** The last draft the turn showed; one per reply. */
export function turnEmailDraft(
  toolExecutions: readonly ToolExecution[] | undefined,
): EmailDraft | null {
  for (const execution of [...(toolExecutions ?? [])].reverse()) {
    if (
      execution.name !== 'draft_email' ||
      execution.isError ||
      execution.blocked
    ) {
      continue;
    }
    try {
      const checked = normalizeEmailDraft(JSON.parse(execution.arguments));
      if (checked.draft) return checked.draft;
    } catch {
      // A call the tool refused never reaches here; unreadable arguments do not show.
    }
  }
  return null;
}

export function replyWithEmailDraft(
  reply: string,
  draft: EmailDraft | null,
  options: { proactive?: boolean } = {},
): { content: string; emailDraft?: MessageEmailDraft } {
  if (!draft) return { content: reply };
  const text = emailDraftText(draft);
  return {
    content: reply.trim() ? `${reply.trimEnd()}\n\n${text}` : text,
    emailDraft: {
      ...draft,
      reply: reply.trim(),
      ...(options.proactive ? { proactive: true as const } : {}),
    },
  };
}
