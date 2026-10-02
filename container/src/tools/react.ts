/**
 * The `react` tool — puts one emoji on the user's message, as a messenger
 * does. Only offered to clients that show reactions. The gateway reads the
 * reaction from the turn's tool executions and stores it with the user's
 * message, so nothing here leaves the worker.
 *
 * A response whose only tool calls are `react` ends the turn (see the agent
 * loop): its text is the reply, so a reaction costs no further model call.
 */
import { REACT_TOOL_NAME, readSingleEmoji } from '../../shared/reactions.js';
import type { ToolDefinition } from '../types.js';

export const REACT_TOOL_DEFINITION: ToolDefinition = {
  type: 'function',
  function: {
    name: REACT_TOOL_NAME,
    description:
      'React to the user’s latest message with one emoji, as a friend does in a messenger: to thanks, a compliment, a joke, an "ok" or a goodbye, where the reaction says it all. Good news and milestones deserve words, so answer those in text. Questions and requests get no reaction, and no message gets more than one.\n' +
      'Calling react with no other tool ends your turn: write your reply, if any, in the same response before the call. When the reaction says it all, react without writing anything.',
    parameters: {
      type: 'object',
      properties: {
        emoji: {
          type: 'string',
          description: 'Exactly one emoji, e.g. "❤️", "😂", "🎉" or "👍"',
        },
      },
      required: ['emoji'],
    },
  },
};

export function runReactTool(args: Record<string, unknown>): {
  ok: boolean;
  text: string;
} {
  const emoji = readSingleEmoji(args.emoji);
  if (!emoji) {
    return {
      ok: false,
      text: 'Error: emoji must be exactly one emoji, such as "👍".',
    };
  }
  return { ok: true, text: `Reacted with ${emoji}.` };
}
