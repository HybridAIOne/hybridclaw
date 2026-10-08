export interface EmailDraft {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  source?: string;
}
/** A draft as stored with the reply that showed it. */
export interface MessageEmailDraft extends EmailDraft {
  /** The agent's own words, without the draft. */
  reply: string;
  /** Drafted by a scheduled run rather than in answer to the user. */
  proactive?: true;
}
export declare function normalizeEmailDraft(
  args: unknown,
):
  | { draft: EmailDraft; error?: undefined }
  | { error: string; draft?: undefined };
export declare function emailDraftText(draft: EmailDraft): string;
