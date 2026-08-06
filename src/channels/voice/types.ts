/**
 * Provider-neutral voice response contract.
 *
 * A VoiceResponseStream is finished exactly once; push() may stream partial
 * tokens before that, and implementations decide whether tokens reach the
 * caller incrementally (Twilio ConversationRelay) or only as one spoken turn
 * on finish (Vonage NCCO transfer). The gateway turn loop only ever depends
 * on this interface, never on a concrete provider stream.
 *
 * NOT the session store — call lifecycle state lives in session.ts.
 */

export interface VoiceResponseStream {
  readonly finished: boolean;
  readonly hasEmittedText: boolean;
  push(token: string, opts?: { language?: string }): Promise<void>;
  reply(text: string, opts?: { language?: string }): Promise<void>;
  finish(opts?: { language?: string }): Promise<void>;
}
