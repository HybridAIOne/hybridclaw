/**
 * The `track` tool — the agent's door to the user's goals and tracked items,
 * which live on the gateway (`POST /api/track`). Each item has a status line
 * the agent keeps current, so the user's Goals page shows where it stands.
 *
 * NOT `todo` (what the user does on a day) and NOT `cron` (when the agent
 * acts); an item may own one check-in, set with "every" and "at".
 */
import type { ToolDefinition } from '../types.js';
import { type GatewayToolTarget, postGatewayTool } from './gateway-tool.js';

export const TRACK_TOOL_DEFINITION: ToolDefinition = {
  type: 'function',
  function: {
    name: 'track',
    description:
      'Keep the user’s goals ("sleep through the night", "run a half marathon") and what you track for them ("airline refund", "ticket prices for the Boston trip"). Each item has a one-line status that the user sees on their Goals page. Actions:\n' +
      '- "list": every item with its status, steps and check-ins\n' +
      '- "add": needs "title"; optional "kind", "outcome", "status", "every", "at", "tz"\n' +
      '- "status": set "status" of item "id" to where it stands now\n' +
      '- "edit": change "title", "kind", "outcome", "every", "at" or "tz" of item "id"\n' +
      '- "add_step" ("step"), "step_done" / "step_undo" / "remove_step" ("step_id"): the plan\n' +
      '- "done" / "undo": the outcome is reached, or not after all\n' +
      '- "remove": delete item "id"\n' +
      'Add an item when the user says what they want to reach or asks you to keep an eye on something. Whenever you learn where an item stands, set its status: short and concrete ("Refund approved, posts in 5–7 days"). Use "every" when the item needs you to look again on your own, or the user asks you to check in; leave it out when the user drives it. A goal’s check-in writes to the user every time, a tracked item’s only when there is news.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description:
            '"list", "add", "status", "edit", "add_step", "step_done", "step_undo", "remove_step", "done", "undo" or "remove"',
        },
        id: { type: 'number', description: 'Item id, from "list"' },
        title: {
          type: 'string',
          description: 'Short title, e.g. "Airline refund"',
        },
        kind: {
          type: 'string',
          description:
            '"goal" for something the user wants to reach, "tracking" for something you watch for them',
        },
        outcome: {
          type: 'string',
          description: 'What success looks like, in one or two sentences',
        },
        status: {
          type: 'string',
          description: 'One line, at most 200 characters, on where it stands',
        },
        every: {
          type: 'string',
          description:
            'Check-in days: "daily", "weekdays", days such as "mon,thu", or "none"',
        },
        at: {
          type: 'string',
          description: 'Time HH:MM of the check-in, in "tz"; default 09:00',
        },
        tz: {
          type: 'string',
          description:
            'The user’s IANA time zone, e.g. "Europe/Berlin"; default: the Timezone in USER.md. Give it when USER.md has none or the result shows a zone that is not the user’s.',
        },
        step: { type: 'string', description: 'Title of a new step' },
        step_id: { type: 'number', description: 'Step id, from "list"' },
      },
      required: ['action'],
    },
  },
};

export async function runTrackTool(
  args: Record<string, unknown>,
  gateway: GatewayToolTarget,
): Promise<{ ok: boolean; text: string }> {
  return await postGatewayTool('/api/track', 'goals', args, gateway);
}
