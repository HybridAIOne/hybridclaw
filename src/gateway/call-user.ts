/**
 * The gateway side of the `call_user` tool (`POST /api/call-user`) and of the
 * phone declining a call (`POST /api/chat/voice/calls/<callId>/decline`).
 *
 * A call rings only the phones of the chat owner that turned on calls from Hy
 * (kind `call`), never while another call of theirs rings or is live, at night
 * or outside active hours unless the user asked for it, or after three
 * unanswered calls in an hour. A scheduled run kept apart from its chat calls
 * from the chat its reply is delivered to. The tool answer waits for the outcome, so the turn knows
 * whether to write its message instead.
 *
 * NOT the call's state (`phone-calls.ts`) nor the live conversation
 * (`webchat-voice.ts`, which answers a call through its start frame's `callId`).
 */
import type { ServerResponse } from 'node:http';
import { isWithinCallHours } from '../agent/proactive-policy.js';
import { getAgentById } from '../agents/agent-registry.js';
import { GatewayRequestError } from '../errors/gateway-request-error.js';
import { getSessionById } from '../memory/sessions.js';
import { isRecord } from '../utils/type-guards.js';
import { currentWork } from '../work/work-tool.js';
import { readUserTimezone } from '../workspace.js';
import { sendJson } from './gateway-http-utils.js';
import { phoneAssistantName, ringPhonesForCall } from './mobile-push.js';
import {
  createPhoneCall,
  declinePhoneCall,
  failPhoneCall,
  type PhoneCallState,
  phoneCallRefusal,
  waitForPhoneCall,
} from './phone-calls.js';
import {
  readSessionCallDevices,
  webNotificationSessionOperator,
} from './web-notification-store.js';
import { mainChatForWebTask } from './web-scheduled-delivery.js';

export const CALL_USER_PATH = '/api/call-user';
const DECLINE_PATH = /^\/api\/chat\/voice\/calls\/([0-9a-f-]{36})\/decline$/i;

const MAX_REASON_CHARS = 120;
const MAX_OPENING_CHARS = 500;
const MAX_NOTES_CHARS = 4000;

type CallUserStatus =
  | PhoneCallState
  | 'not_allowed'
  | 'busy'
  | 'quiet_hours'
  | 'rate_limited';

const WRITE_INSTEAD =
  "The user didn't take the call. Write what you wanted to tell them in your reply now.";

// What the turn does next, by outcome. Every answer but `answered` means the
// message belongs in the chat.
const MESSAGES: Record<Exclude<CallUserStatus, 'ringing'>, string> = {
  answered:
    "The user picked up and the call is live. End your turn with one short line such as 'Called you about <reason>.' Don't repeat what you'll say on the call.",
  declined: WRITE_INSTEAD,
  missed: WRITE_INSTEAD,
  failed:
    'No phone could be reached. Write what you wanted to tell them in your reply now.',
  not_allowed:
    "The user hasn't turned on calls from Hy in the app. Did not call. Write your message in the chat instead.",
  busy: 'Another call from Hy is still ringing or live. Did not call. Write your message in the chat instead.',
  quiet_hours:
    "It is outside the user's active hours and they did not ask for this call. Did not call. Write your message in the chat instead.",
  rate_limited:
    'Three calls went unanswered in the last hour. Did not call. Write your message in the chat instead.',
};

function answer(
  status: Exclude<CallUserStatus, 'ringing'>,
  callId?: string,
): { ok: true; result: string } {
  return {
    ok: true,
    result: JSON.stringify({
      status,
      ...(callId ? { callId } : {}),
      message: MESSAGES[status],
    }),
  };
}

function readText(
  body: Record<string, unknown>,
  field: string,
  limit: number,
): string | null {
  const value = body[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string')
    throw new GatewayRequestError(400, `\`${field}\` must be a string.`);
  const text = value.trim();
  if (text.length > limit)
    throw new GatewayRequestError(
      400,
      `\`${field}\` must be at most ${limit} characters.`,
    );
  return text || null;
}

/**
 * The chat a call from this turn belongs to. A chat turn calls from its own
 * chat. A scheduled run kept apart (`--reply-only`, a side chat's task, a
 * fresh session) runs in a session no one owns, so it calls from where its
 * reply goes: the agent's main chat, else the task's own chat.
 */
function callChatId(sessionId: string): string {
  if (webNotificationSessionOperator(sessionId)) return sessionId;
  const taskChat = currentWork(sessionId)?.sessionId;
  if (!taskChat) return sessionId;
  return mainChatForWebTask(taskChat)?.id ?? taskChat;
}

/** Rings the user's phone for the calling turn and waits for the outcome. */
export async function runCallUserTool(
  body: unknown,
  now = new Date(),
): Promise<{ ok: true; result: string }> {
  if (!isRecord(body))
    throw new GatewayRequestError(400, 'Request body must be a JSON object.');
  const reason = readText(body, 'reason', MAX_REASON_CHARS);
  if (!reason) throw new GatewayRequestError(400, '`reason` is required.');
  const opening = readText(body, 'opening', MAX_OPENING_CHARS);
  const notes = readText(body, 'notes', MAX_NOTES_CHARS);
  const asked = body.asked === true;
  const turnSessionId =
    typeof body.sessionId === 'string' ? body.sessionId : '';
  const turnSession = turnSessionId ? getSessionById(turnSessionId) : undefined;
  if (!turnSession) throw new GatewayRequestError(404, 'Unknown session.');
  const sessionId = callChatId(turnSessionId);
  const agentId = getSessionById(sessionId)?.agent_id ?? turnSession.agent_id;

  const { operatorId, devices } = readSessionCallDevices(sessionId);
  if (!operatorId || !devices.length) return answer('not_allowed');
  const refusal = phoneCallRefusal(operatorId, now.getTime());
  if (refusal === 'busy') return answer('busy');
  if (!asked && !isWithinCallHours(now, readUserTimezone(agentId)))
    return answer('quiet_hours');
  if (refusal === 'rate_limited') return answer('rate_limited');

  const call = createPhoneCall(
    { operatorId, sessionId, agentId, reason, opening, notes, asked },
    now.getTime(),
  );
  const rung = await ringPhonesForCall(devices, {
    callId: call.callId,
    sessionId,
    agentId,
    assistant: phoneAssistantName(agentId, getAgentById(agentId)),
    reason,
    expiresAt: call.expiresAt,
  });
  if (!rung.sent) failPhoneCall(call.callId);
  const state = await waitForPhoneCall(call.callId);
  return answer(state === 'ringing' ? 'missed' : state, call.callId);
}

/**
 * `POST /api/chat/voice/calls/<callId>/decline` for the operator the request
 * names; 404 for a call that is not theirs or no longer rings, so a caller
 * learns nothing about other people's calls. False for any other path.
 */
export function handleDeclineCallRoute(
  res: ServerResponse,
  pathname: string,
  operatorId: string | null,
): boolean {
  const match = DECLINE_PATH.exec(pathname);
  if (!match) return false;
  if (declinePhoneCall(match[1].toLowerCase(), operatorId))
    sendJson(res, 200, { ok: true });
  else sendJson(res, 404, { error: 'No such ringing call.' });
  return true;
}
