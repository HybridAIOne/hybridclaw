/**
 * The `call_user` tool: rings the user's phone like a real call and waits for
 * the outcome (`POST /api/call-user`, `src/gateway/call-user.ts`). Only the
 * user's own phones that turned on calls from Hy ring; the gateway refuses
 * without ringing when that is off, a call is already on, it is outside
 * active hours or too many calls went unanswered.
 *
 * NOT a scheduler: a call at a set time or after a delay is a one-shot cron
 * task whose instruction says to call with this tool, `asked` true.
 */
import type { ToolDefinition } from '../types.js';
import { type GatewayToolTarget, postGatewayTool } from './gateway-tool.js';

// Kept under 2,000 characters as JSON (owner call 2026-10-11, after a live
// test): larger schemas go behind tool_catalog when MCP tools are deferred
// (`tool-catalog.ts`), and the model then has to search for the tool.
export const CALL_USER_TOOL_DEFINITION: ToolDefinition = {
  type: 'function',
  function: {
    name: 'call_user',
    description:
      "Ring the user's phone and talk to them live. Call only when the user asked for a call, or for something urgent that cannot wait for a message.\n" +
      '- When the user names a time or delay ("in a minute", "at 7"), never call now: add a one-shot cron task (at or at_seconds) whose prompt says "The user asked for this call: call them with call_user, asked true, about <topic>" and gives what to tell them.\n' +
      '- Set asked to true whenever the user requested the call, now or scheduled.\n' +
      '- Put everything to say in notes: the voice says the opening, then tells the notes.\n' +
      'Result status: "answered": the call is live; end your turn with one short line such as "Called you about <reason>." "declined", "missed", "failed": write your message in the reply. "not_allowed", "busy", "quiet_hours", "rate_limited": nothing rang; write your message in the chat and do not retry.',
    parameters: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description:
            'Shown on the ringing screen, at most 120 characters, e.g. "Your 7:00 brief"',
        },
        opening: {
          type: 'string',
          description: 'First sentence when the user picks up',
        },
        notes: {
          type: 'string',
          description:
            'What to tell the user, in their language, at most 4000 characters; said right after the opening',
        },
        asked: {
          type: 'boolean',
          description:
            'true when the user requested this call; unasked calls never ring at night',
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
