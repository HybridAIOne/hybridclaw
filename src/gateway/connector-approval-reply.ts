/**
 * Connector replies are interpreted at the host, which alone holds the broker
 * proof. Worker output cannot authorize a connector; the caller, live prompt
 * and one-shot scope are checked again before crossing that boundary.
 */
import {
  APPROVAL_REPLY_INSTRUCTIONS,
  type ApprovalReplyDecision,
  parseApprovalReplyDecision,
} from '#shared/approval-reply.js';
import { platformApprovalId } from '#shared/connector-approval.js';
import { extractResponseTextContent } from '#shared/response-text.js';
import { callAuxiliaryModel } from '../providers/auxiliary.js';
import type { ChatMessage } from '../types/api.js';
import type { ContainerOutput } from '../types/container.js';
import { enqueueTokenUsage } from '../usage/token-usage-buffer.js';
import { approvalReplyContext } from './chat-approval.js';
import { forwardConnectorDecision } from './connector-approval.js';
import type { GatewayChatRequest } from './gateway-types.js';
import { getPendingApproval, setPendingApproval } from './pending-approvals.js';

export async function resolveConnectorApprovalReply(
  req: GatewayChatRequest,
  messages: ChatMessage[],
  model: string,
  agentId: string,
  runId: string,
  signal?: AbortSignal,
): Promise<ApprovalReplyDecision | undefined> {
  const text = approvalReplyContext(req, req.content).approvalUserText;
  const pending = getPendingApproval(req.sessionId);
  if (
    !text?.trim() ||
    req.approval ||
    !pending?.approval ||
    !platformApprovalId(pending.approvalId) ||
    pending.userId !== req.userId ||
    pending.resolvedAt ||
    pending.expiresAt <= Date.now()
  )
    return undefined;
  try {
    const result = await callAuxiliaryModel({
      task: 'eval_judge',
      fallbackModel: model,
      agentId,
      tools: [],
      maxTokens: 500,
      allowFallback: false,
      messages: [
        { role: 'system', content: APPROVAL_REPLY_INSTRUCTIONS },
        {
          role: 'user',
          content: JSON.stringify({
            pending: [
              {
                approvalId: pending.approvalId,
                tool: pending.approval.toolName,
                arguments:
                  pending.approval.reviewArguments ||
                  pending.approval.commandPreview,
                reason: pending.approval.reason,
                allowedScopes: ['once'],
              },
            ],
            lastAssistantMessage: extractResponseTextContent(
              [...messages]
                .reverse()
                .find((message) => message.role === 'assistant')?.content,
            ),
            userReply: text,
          }),
        },
      ],
    });
    enqueueTokenUsage({
      sessionId: req.sessionId,
      agentId,
      auditRunId: runId,
      model: result.model,
      inputTokens: result.usage?.inputTokens || 0,
      outputTokens: result.usage?.outputTokens || 0,
      ...result.usage,
    });
    if (signal?.aborted) throw new Error('Approval interpretation interrupted');
    const decision = parseApprovalReplyDecision(result.content, [
      { id: pending.approvalId, pinned: true },
    ]);
    if (['approve', 'deny', 'revise'].includes(decision.decision)) {
      await forwardConnectorDecision(
        {
          approvalId: pending.approvalId,
          decision: decision.decision === 'approve' ? 'yes' : 'no',
        },
        req.sessionId,
        req.userId,
      );
    }
    return { ...decision, model: result.model };
  } catch {
    // No worker retry may turn an interpretation or broker error into consent.
    return { decision: 'error', approvalId: null, scope: null, reply: '' };
  }
}

export async function rememberConnectorApproval(
  req: GatewayChatRequest,
  output: ContainerOutput,
): Promise<void> {
  const approval = output.pendingApproval;
  if (!approval || !platformApprovalId(approval.approvalId)) return;
  if (getPendingApproval(req.sessionId)?.approvalId === approval.approvalId)
    return;
  await setPendingApproval(req.sessionId, {
    approvalId: approval.approvalId,
    approval,
    prompt: approval.prompt,
    userId: req.userId,
    createdAt: Date.now(),
    expiresAt: approval.expiresAt ?? Date.now(),
  });
}
