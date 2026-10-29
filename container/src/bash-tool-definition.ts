/**
 * The shell schema asks for a concrete explanation in the user's language.
 * Approval-call preparation separates that display metadata from executable
 * arguments; this module defines the schema, not parsing or authorization.
 */
import { MAX_BASH_DESCRIPTION_CHARS } from './approval-tool-call.js';
import type { ToolDefinition } from './types.js';

export function bashToolDefinition(description: string): ToolDefinition {
  return {
    type: 'function',
    function: {
      name: 'bash',
      description,
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to execute' },
          description: {
            type: 'string',
            description: `Provide this description on each command: explain the concrete action in 1–2 short sentences (up to ${MAX_BASH_DESCRIPTION_CHARS} characters) in the user’s language, for a non-technical person. Name what will be copied, changed, deleted, sent, or read and any destination or side effect. Do not include shell syntax, ask for approval, claim the action is safe, or say it has already happened. This text is shown when permission is needed.`,
          },
          timeoutMs: {
            type: 'number',
            description:
              'Optional command timeout in milliseconds (default 240000, max 900000)',
          },
          timeoutSeconds: {
            type: 'number',
            description:
              'Optional command timeout in seconds (used when timeoutMs is omitted)',
          },
        },
        // Display metadata is optional: saved approvals replay executable args only.
        required: ['command'],
      },
    },
  };
}
