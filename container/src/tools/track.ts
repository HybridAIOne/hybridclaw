/**
 * The `track` tool — the agent's door to the user's goals and tracked items,
 * which live on the gateway (`POST /api/track`). Each item has a status line
 * the agent keeps current, so the user's Goals page shows where it stands.
 * Prepared results attach dated workspace copies to the same durable goal.
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
      '- "list": every item with its status, saved results, steps and check-ins\n' +
      '- "add": needs "title"; optional "kind", "outcome", "status", "every", "at", "tz"\n' +
      '- "status": set "status" of item "id" to where it stands now\n' +
      '- "result": attach prepared work to item "id" with "title", "summary" and a workspace-relative "path"; saves a dated copy that later edits cannot change\n' +
      '- "edit": change "title", "kind", "outcome", "every", "at" or "tz" of item "id"\n' +
      '- "add_step" ("step"), "step_done" / "step_undo" / "remove_step" ("step_id"): the plan\n' +
      '- "done" / "undo": the outcome is reached, or not after all\n' +
      '- "remove": delete item "id"\n' +
      'Add an item when the user says what they want to reach or asks you to keep an eye on something. Whenever you learn where an item stands, set its status: short and concrete ("Refund approved, posts in 5–7 days"). Use "every" when the item needs you to look again on your own, or the user asks you to check in; leave it out when the user drives it. After preparing useful work toward a goal, save it with "result" and link to the returned saved path in your reply. Never attach missing files or claim that a draft was sent. A goal’s check-in writes to the user every time, a tracked item’s only when there is news; it is the only check-in the item needs, so add no cron task for it.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description:
            '"list", "add", "status", "result", "edit", "add_step", "step_done", "step_undo", "remove_step", "done", "undo" or "remove"',
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
        summary: {
          type: 'string',
          description:
            'Factual summary of a prepared result, at most 1000 characters',
        },
        path: {
          type: 'string',
          description:
            'Existing result file relative to this agent workspace, e.g. goals/training-plan.md',
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
