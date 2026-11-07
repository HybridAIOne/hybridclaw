/**
 * Reapply selected coordination and argument rules after fresh evidence.
 * Unlike approval policy, this is model guidance and grants no authority.
 * Only an existing system policy enables it; tool or user text cannot opt in.
 */
import {
  ACTION_PREREQUISITE_CHECKPOINT,
  ACTION_PREREQUISITE_LINES,
} from '#shared/action-prerequisites.js';
import { TOOL_ARGUMENT_CARDINALITY } from '#shared/tool-argument-contract.js';
import type { ChatMessage } from './types.js';

const policy = ACTION_PREREQUISITE_LINES.join('\n');

export function appendActionPrerequisiteCheckpoint(
  history: ChatMessage[],
): void {
  if (history.at(-1)?.role !== 'tool') return;
  if (
    !history.some(
      (message) =>
        message.role === 'system' &&
        typeof message.content === 'string' &&
        message.content.includes(policy) &&
        message.content.includes(TOOL_ARGUMENT_CARDINALITY),
    )
  )
    return;
  history.push({ role: 'user', content: ACTION_PREREQUISITE_CHECKPOINT });
}
