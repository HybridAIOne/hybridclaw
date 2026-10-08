/**
 * The `draft_email` tool: shows the user an email the agent drafted, as a card
 * with the user's Send and Discard. The gateway reads the call from the turn's
 * tool executions and stores the draft with the reply (`src/gateway/email-draft.ts`).
 *
 * NOT a send: the mail connector's send tool, with its approval, sends. The
 * user's Send comes back as a new message asking for exactly this draft.
 */
import { normalizeEmailDraft } from '../../shared/email-draft.js';
import type { ToolDefinition } from '../types.js';

export const DRAFT_EMAIL_TOOL_DEFINITION: ToolDefinition = {
  type: 'function',
  function: {
    name: 'draft_email',
    description:
      'Show the user an email you drafted for them, as an email card they can edit, send or discard. Use it for every email draft you prepare, a reply or a new email, instead of writing the draft in your reply; then say in one short sentence what you drafted, without repeating it. One draft per reply. This sends nothing, and you never send it yourself: when the user taps Send, they ask you in a new message to send exactly that version. Every draft has from, to and subject. For a reply, read them from the original email and the connected account: from is the user’s address it was sent to, to is its sender (or its Reply-To address), cc keeps the others on it only when the reply is for them too, and subject is its subject with Re: in front. For a new email whose recipient you do not know, ask the user instead of drafting. Never guess recipients or account details.',
    parameters: {
      type: 'object',
      properties: {
        from: {
          type: 'string',
          description:
            'The user’s address the email is sent from; for a reply, the address the original email was sent to',
        },
        to: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Recipient addresses, e.g. ["name@example.com"]; for a reply, the original sender or Reply-To',
        },
        cc: { type: 'array', items: { type: 'string' } },
        bcc: { type: 'array', items: { type: 'string' } },
        subject: {
          type: 'string',
          description: 'For a reply, the original subject with Re: in front',
        },
        body: {
          type: 'string',
          description:
            'The complete plain-text email, including greeting and signature',
        },
        source: {
          type: 'string',
          description:
            'The connected service, account and original thread, so the email can be sent from there later',
        },
      },
      required: ['from', 'to', 'subject', 'body'],
    },
  },
};

export function runDraftEmailTool(args: Record<string, unknown>): {
  ok: boolean;
  text: string;
} {
  const checked = normalizeEmailDraft(args);
  if (checked.error !== undefined) return { ok: false, text: checked.error };
  return {
    ok: true,
    text: 'The user sees the draft as an email card with Send and Discard. Nothing was sent. Say in one short sentence what you drafted; do not repeat it.',
  };
}
