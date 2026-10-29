/**
 * Shell descriptions explain the pending action in the user's language.
 * They are display-only and removed before policy and fingerprint checks;
 * the shell executor reads only the command and timeouts.
 */
import { isRecord } from '../shared/primitive-values.js';
import { normalizeText } from './text-normalization.js';
import type { ToolDefinition } from './types.js';

// 600 characters (Codex implementation choice, 2026-10-29): enough for two
// concrete sentences; longer explanations belong in the on-demand review.
const MAX_DESCRIPTION_CHARS = 600;

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
            description: `Provide this description on each command: explain the concrete action in 1–2 short sentences (up to ${MAX_DESCRIPTION_CHARS} characters) in the user’s language, for a non-technical person. Name what will be copied, changed, deleted, sent, or read and any destination or side effect. Do not include shell syntax, ask for approval, claim the action is safe, or say it has already happened. This text is shown when permission is needed.`,
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

export function bashApprovalInput(argsJson: string): {
  argsJson: string;
  description?: string;
} {
  try {
    const args: unknown = JSON.parse(argsJson);
    if (!isRecord(args)) return { argsJson };
    const { description, ...executionArgs } = args;
    const text =
      typeof description === 'string' ? normalizeText(description) : '';
    return {
      argsJson: JSON.stringify(executionArgs),
      ...(text && text.length <= MAX_DESCRIPTION_CHARS
        ? { description: text }
        : {}),
    };
  } catch {
    return { argsJson };
  }
}
