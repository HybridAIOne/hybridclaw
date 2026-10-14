/**
 * Applies captured human input before a worker turn. Host connector decisions
 * take precedence; a voice model's generated request cannot answer a boost or
 * approval. The tool loop still owns execution of the resulting saved call.
 */
import { resolveApprovalReply } from './approval-reply.js';
import { handleBoostAnswer } from './boost-offers.js';
import { approvalRuntime } from './tool-approval.js';
import type { ChatMessage, ContainerInput } from './types.js';

export async function resolveApprovalPrelude(
  input: ContainerInput,
  messages: ChatMessage[],
) {
  return (
    (input.approvalReplyDecision
      ? null
      : handleBoostAnswer(input.sessionId, messages, input.approvalUserText)) ??
    (await resolveApprovalReply(
      approvalRuntime,
      input.approvalUserText,
      messages,
      input.approvalReplyDecision,
    ))
  );
}
