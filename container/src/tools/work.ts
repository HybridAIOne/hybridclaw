/**
 * The model's access to gateway-owned background-work provenance.
 * Records reasons, never delivery claims; identity comes from the current turn.
 */
import type { ToolDefinition } from '../types.js';
import { type GatewayToolTarget, postGatewayTool } from './gateway-tool.js';
export const WORK_TOOL_DEFINITION: ToolDefinition = {
  type: 'function',
  function: {
    name: 'work',
    description:
      'Save and retrieve the actual reason and evidence behind background suggestions. Before acting in a background run, record the reason and source references you read. For “why did you suggest this?” use get with the work id, or list to find it. Explain saved evidence, never reconstruct a reason from the final reply. Missing rationale or evidence means unknown. Completion, saved in chat, notification attempts, transport acceptance and seen are independent. record is immutable and only available during the active background run.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['record', 'get', 'list'] },
        id: { type: 'string', description: 'Work id for get.' },
        rationale: {
          type: 'string',
          description:
            'Concrete user context and why this work helps; include any evidence gaps.',
        },
        evidence: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              reference: {
                type: 'string',
                description: 'Actual source id, URL, or workspace note path.',
              },
              summary: {
                type: 'string',
                description: 'Relevant observed fact, not hidden reasoning.',
              },
            },
            required: ['reference', 'summary'],
          },
        },
      },
      required: ['action'],
    },
  },
};
export async function runWorkTool(
  args: Record<string, unknown>,
  gateway: GatewayToolTarget,
): Promise<{ ok: boolean; text: string }> {
  return postGatewayTool('/api/work', 'work records', args, gateway);
}
