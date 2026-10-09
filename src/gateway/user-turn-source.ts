/**
 * Where a stored user message came from when the user did not type it.
 *
 * A tagged message reaches the agent like any other, but `/api/history` leaves
 * it out, so no client has to recognize such turns by their wording. NOT the
 * approval answer itself (`approval-answer.ts`), which builds the reply text.
 */

import { APPROVAL_ANSWER_SOURCE } from './approval-answer.js';
import type { GatewayChatRequest } from './gateway-types.js';

/**
 * The app's own note to the agent, such as "I saved my sign-in for
 * example.com. Please continue." after the user did something in the app.
 */
export const APP_NOTICE_SOURCE = 'app-notice';

const HIDDEN_USER_SOURCES: ReadonlySet<string> = new Set([
  APPROVAL_ANSWER_SOURCE,
  APP_NOTICE_SOURCE,
]);

export function userTurnSource(
  req: Pick<GatewayChatRequest, 'approval' | 'appNotice'>,
): string | null {
  if (req.approval) return APPROVAL_ANSWER_SOURCE;
  if (req.appNotice) return APP_NOTICE_SOURCE;
  return null;
}

/** Whether history leaves out a user message with this source. */
export function isHiddenUserSource(source: string | null | undefined): boolean {
  return source != null && HIDDEN_USER_SOURCES.has(source);
}
