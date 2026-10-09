/**
 * The `trigger` tool — "when something arrives, do this". Triggers live on
 * the gateway (`POST /api/trigger`, `event-triggers.ts`) next to scheduled
 * tasks, so apps list, pause and delete them with the rest.
 *
 * NOT `cron`: cron acts at a time; a trigger acts when mail, a Slack message
 * or a webhook call arrives.
 */
import type { ToolDefinition } from '../types.js';
import { type GatewayToolTarget, postGatewayTool } from './gateway-tool.js';

/** A mail trigger's regular look when none is given: every two hours, 8 to 20. */
export const DEFAULT_MAIL_LOOK = '0 8-20/2 * * *';

export const TRIGGER_TOOL_DEFINITION: ToolDefinition = {
  type: 'function',
  function: {
    name: 'trigger',
    description:
      'Act when something arrives instead of at a time: "when an invoice arrives by mail, save it to my Library", "when someone posts a bug in #support, summarise it for me", "give me a web address that adds what it receives to my shopping list". Actions:\n' +
      '- "add": needs "on" and "prompt"; optional "title", "channel", "contains", "cron", "tz"\n' +
      '- "list": the triggers, with their web addresses\n' +
      '- "remove": delete trigger "taskId"\n' +
      'Sources ("on"):\n' +
      '- "mail": new mail in the user’s connected mailboxes. Runs soon after a mailbox announces new mail (Gmail does) and also looks regularly, by default every two hours from 8 to 20 in the user’s time zone; set "cron" for another look or "none" for none.\n' +
      '- "slack": a message in a Slack channel the Slack app can hear. "channel" limits it to one channel, "contains" to messages with that text; give at least one, or every message runs it.\n' +
      '- "webhook": the result gives a secret web address; each POST to it runs the instruction with the request body. Give the user the address and say that anyone who has it can run the instruction.\n' +
      'The "prompt" is the instruction for each run: what to look for and what to do, e.g. "If it is an invoice, save the PDF to the Library and tell me the amount and due date." Each run reads what arrived, does the instruction only when it applies, and messages the user only when it did something. Sending mail, paying or buying still asks the user first. Confirm with the id (and web address) from the result.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: '"add", "list" or "remove"',
        },
        on: {
          type: 'string',
          description: '"mail", "slack" or "webhook"',
        },
        prompt: {
          type: 'string',
          description:
            'What to do with what arrived, including when to do nothing',
        },
        title: {
          type: 'string',
          description: 'Short title the user sees, e.g. "File invoices"',
        },
        channel: {
          type: 'string',
          description: 'Slack: channel name such as "support", or its id',
        },
        contains: {
          type: 'string',
          description: 'Slack: text a message must contain',
        },
        cron: {
          type: 'string',
          description:
            'Mail: 5-field cron for the regular look, in the user’s time zone, or "none"',
        },
        tz: {
          type: 'string',
          description:
            'IANA time zone for "cron"; default: the Timezone in USER.md',
        },
        taskId: { type: 'number', description: 'Trigger id, for "remove"' },
      },
      required: ['action'],
    },
  },
};

export async function runTriggerTool(
  args: Record<string, unknown>,
  gateway: GatewayToolTarget,
  defaults: { tz: string | undefined; channelId: string | undefined },
): Promise<{ ok: boolean; text: string }> {
  const body = { ...args };
  if (body.action === 'add' && body.on === 'mail') {
    const cron = typeof body.cron === 'string' ? body.cron.trim() : '';
    body.cron = cron.toLowerCase() === 'none' ? '' : cron || DEFAULT_MAIL_LOOK;
    if (body.cron && !body.tz && defaults.tz) body.tz = defaults.tz;
  }
  if (defaults.channelId) body.channelId = defaults.channelId;
  return await postGatewayTool('/api/trigger', 'triggers', body, gateway);
}
