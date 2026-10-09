/**
 * The `estimate_cost` tool: before a big task, the gateway works out what it
 * is likely to cost (`POST /api/cost-estimate`) from the session's model and
 * context, the reply shows that as a card, and the agent asks to go ahead.
 *
 * NOT a price list: the agent never states a price of its own.
 */
import type { ToolDefinition } from '../types.js';
import { type GatewayToolTarget, postGatewayTool } from './gateway-tool.js';

export const ESTIMATE_COST_TOOL_DEFINITION: ToolDefinition = {
  type: 'function',
  function: {
    name: 'estimate_cost',
    description:
      'Before a big task, show the user what it will likely cost, as a card under your reply. Use it before you start work you expect to take more than about 15 tool calls, such as deep research, comparing many offers, going through many emails or pages, or a long browser session. Then say in one short sentence what you will do, ask whether to go ahead, and end your reply; start only after they agree. Skip it when the user already agreed to this task or its cost, and for small tasks.',
    parameters: {
      type: 'object',
      properties: {
        steps: {
          type: 'number',
          description:
            'How many tool calls you expect the task to take, e.g. 30',
        },
      },
      required: ['steps'],
    },
  },
};

export async function runEstimateCostTool(
  args: Record<string, unknown>,
  gateway: GatewayToolTarget,
): Promise<{ ok: boolean; text: string }> {
  return await postGatewayTool(
    '/api/cost-estimate',
    'cost estimates',
    args,
    gateway,
  );
}
