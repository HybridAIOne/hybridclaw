/**
 * The `call_user` tool: rings the user's phone like a real call and waits for
 * the outcome (`POST /api/call-user`, `src/gateway/call-user.ts`). Only the
 * user's own phones that turned on calls from Hy ring; the gateway refuses
 * without ringing when that is off, a call is already on, it is outside
 * active hours or too many calls went unanswered.
 *
 * NOT a scheduler: a call at a set time is a scheduled task whose
 * instruction says to call with this tool.
 */
import type { ToolDefinition } from '../types.js';
import { type GatewayToolTarget, postGatewayTool } from './gateway-tool.js';

export const CALL_USER_TOOL_DEFINITION: ToolDefinition = {
  type: 'function',
  function: {
    name: 'call_user',
    description:
      "Ring the user's phone and talk to them live. Call only when the user asked to be called (now, or at a set time), or for something urgent that cannot wait for a message; everything else is a message. To call at a set time, schedule a task whose instruction says to call the user with call_user. The result is JSON with a status:\n" +
      '- "answered": the call is live and its voice speaks for you. End your turn with one short line such as "Called you about <reason>." and do not repeat what the call covers.\n' +
      '- "declined", "missed" or "failed": the user did not take the call. Write what you wanted to tell them in your reply.\n' +
      '- "not_allowed" (calls from Hy are off in the app), "busy", "quiet_hours" or "rate_limited": nothing rang. Write your message in the chat instead; do not try again.',
    parameters: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description:
            'Why you are calling, shown on the ringing screen; at most 120 characters, e.g. "Your 7:00 brief"',
        },
        opening: {
          type: 'string',
          description:
            'The first sentence you say when the user picks up; default "Hi, it\'s Hy. <reason>."',
        },
        notes: {
          type: 'string',
          description:
            'What to cover on the call, for the voice that talks to the user; at most 4000 characters',
        },
        asked: {
          type: 'boolean',
          description:
            'true when the user asked for this call, such as a wake-up call they scheduled; it may then ring outside active hours',
        },
      },
      required: ['reason'],
    },
  },
};

export async function runCallUserTool(
  args: Record<string, unknown>,
  gateway: GatewayToolTarget,
): Promise<{ ok: boolean; text: string }> {
  const { reason, opening, notes, asked } = args;
  return await postGatewayTool(
    '/api/call-user',
    'calls',
    { reason, opening, notes, asked },
    gateway,
  );
}
