/**
 * Interprets only transport-captured user replies to live approvals, in any
 * language. The policy runtime owns grants and exact-call replay; this module
 * cannot edit tool arguments, grant an unknown scope, or execute a tool.
 */
import {
  APPROVAL_REPLY_INSTRUCTIONS,
  type ApprovalReplyDecision,
  type ApprovalReplyInterpretation,
  parseApprovalReplyDecision,
} from '../shared/approval-reply.js';
import { parseApprovalDirective } from './approval-directive.js';
import type {
  ApprovalPrelude,
  TrustedAgentApprovalRuntime,
} from './approval-policy.js';
import { approvalReviewArguments } from './approval-review.js';
import { captureAuxiliaryRuntimeContext } from './model-context.js';
import type { PendingApproval } from './pending-approval-store.js';
import { callAuxiliaryModel } from './providers/auxiliary.js';
import {
  accumulateApiUsage,
  createTokenUsageStats,
  finalizeTokenUsage,
  normalizeContentText,
} from './token-usage.js';
import type {
  ChatCompletionResponse,
  ChatMessage,
  ContainerOutput,
} from './types.js';

function waiting(pending: PendingApproval[], reply: string): ApprovalPrelude {
  const target = pending.length === 1 ? pending[0] : null;
  return {
    immediateMessage: reply,
    ...(target
      ? {
          pendingApproval: {
            approvalId: target.id,
            prompt: reply,
            intent: target.intent,
            reason: target.reason,
            toolName: target.toolName,
            commandPreview: target.commandPreview,
            reviewArguments: approvalReviewArguments(
              target.toolName,
              target.argsJson,
            ),
            allowSession: !target.pinned,
            allowAgent: !target.pinned,
            allowAll: !target.pinned,
            expiresAt: target.expiresAtMs,
          },
        }
      : {}),
  };
}

export async function resolveApprovalReply(
  runtime: TrustedAgentApprovalRuntime,
  userText: string | null | undefined,
  messages: ChatMessage[],
  hostDecision?: ApprovalReplyDecision,
): Promise<ApprovalPrelude | null> {
  // Explicitly absent user speech (or an autonomous turn) is never consent.
  if (userText === null) return null;
  // Direct worker callers retain their existing command protocol. Natural
  // replies require the gateway's separate, unaugmented user input.
  if (userText === undefined) return runtime.handleApprovalResponse(messages);
  const pending = runtime.getPendingApprovals();
  if (!pending.length || !userText.trim()) return null;
  const directive = parseApprovalDirective(userText);
  if (
    !hostDecision &&
    directive?.requestId &&
    pending.some((item) => item.id === directive.requestId)
  )
    return runtime.resolveApprovalResponse(directive);
  let modelResponse: ChatCompletionResponse | undefined;
  try {
    if (hostDecision?.decision === 'error')
      throw new Error('Host interpretation unavailable');
    const result = hostDecision
      ? {
          content: JSON.stringify({
            decision: hostDecision.decision,
            approvalId: hostDecision.approvalId,
            scope: hostDecision.scope,
            reply: hostDecision.reply,
          }),
          model: hostDecision.model,
          response: undefined,
        }
      : await callAuxiliaryModel({
          ...captureAuxiliaryRuntimeContext(),
          task: 'eval_judge',
          toolName: 'approval_reply',
          tools: [],
          maxTokens: 500,
          messages: [
            { role: 'system', content: APPROVAL_REPLY_INSTRUCTIONS },
            {
              role: 'user',
              content: JSON.stringify({
                pending: pending.map((item) => ({
                  approvalId: item.id,
                  tool: item.toolName,
                  arguments: item.argsJson,
                  originalRequest: item.originalPrompt,
                  reason: item.reason,
                  allowedScopes: item.pinned
                    ? ['once']
                    : ['once', 'session', 'agent', 'all'],
                })),
                lastAssistantMessage: normalizeContentText(
                  [...messages]
                    .reverse()
                    .find((message) => message.role === 'assistant')?.content ??
                    null,
                ),
                userReply: userText,
              }),
            },
          ],
        });
    modelResponse = result.response;
    const decision = parseApprovalReplyDecision(result.content, pending);
    const interpretation: ApprovalReplyInterpretation = {
      decision: decision.decision,
      approvalId: decision.approvalId,
      scope: decision.scope,
      model: result.model,
    };
    // The call above may outlive the prompt, or another answer may have won.
    const live = runtime.getPendingApprovals();
    if (
      decision.approvalId &&
      !live.some((item) => item.id === decision.approvalId)
    ) {
      return {
        immediateMessage:
          'That approval is no longer pending. Please request the action again.',
        interpretation,
        modelResponse: result.response,
      };
    }
    if (decision.decision === 'error')
      throw new Error('Invalid approval decision');
    if (decision.decision === 'unrelated')
      return { interpretation, modelResponse: result.response };
    if (decision.decision === 'unclear')
      return {
        ...waiting(live, decision.reply),
        interpretation,
        modelResponse: result.response,
      };
    const resolved = runtime.resolveApprovalResponse({
      requestId: decision.approvalId || '',
      kind: decision.decision,
      ...(decision.scope ? { mode: decision.scope } : {}),
    });
    return {
      ...resolved,
      ...(decision.decision === 'revise'
        ? { replayPrompt: userText }
        : resolved?.replayPrompt
          ? {
              replayPrompt: `${resolved.replayPrompt}\n\nCurrent user reply: ${userText}`,
            }
          : {}),
      interpretation,
      modelResponse: result.response,
      ...(decision.decision === 'deny'
        ? { immediateMessage: decision.reply }
        : {}),
    };
  } catch {
    // Do not let a failed interpretation fall through to another tool attempt.
    return {
      ...waiting(
        runtime.getPendingApprovals(),
        'I could not interpret that approval. Please answer again or use the approval buttons.',
      ),
      modelResponse,
      interpretation: { decision: 'error', approvalId: null, scope: null },
    };
  }
}

export function withApprovalReplyUsage(
  output: ContainerOutput,
  prelude: ApprovalPrelude | null,
): ContainerOutput {
  if (prelude?.interpretation)
    output = { ...output, approvalReply: prelude.interpretation };
  if (!prelude?.modelResponse) return output;
  const usage = output.tokenUsage || createTokenUsageStats();
  usage.modelCalls += 1;
  accumulateApiUsage(usage, prelude.modelResponse);
  return { ...output, tokenUsage: finalizeTokenUsage(usage) };
}
