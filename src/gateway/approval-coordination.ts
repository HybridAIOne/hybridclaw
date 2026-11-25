/**
 * Gateway claims coordinate human responses across transports, never tool consent.
 * A failed or interrupted dispatch retains its claim until expiry; restart cannot
 * turn an ambiguous handoff into a retry. OpenAI pauses retain gateway-selected
 * dispatch context; HTTP answers cannot replace it. The worker validates tools.
 */
import { GatewayRequestError } from '../errors/gateway-request-error.js';
import type { GatewayChatRequest, GatewayChatResult } from './gateway-types.js';
import {
  claimPendingApprovalByApprovalId,
  getPendingApproval,
  handoffPendingApprovalClaim,
  isPendingApprovalClaim,
  type PendingApprovalClaim,
  setPendingApproval,
} from './pending-approvals.js';

export function claimApprovalResponse(
  sessionId: string,
  approvalId: string,
  userId: string,
  supplied?: PendingApprovalClaim,
): PendingApprovalClaim {
  if (supplied) {
    const pending = getPendingApproval(sessionId);
    if (
      supplied.sessionId === sessionId &&
      supplied.approvalId === approvalId &&
      pending?.userId === userId &&
      isPendingApprovalClaim(supplied)
    )
      return supplied;
    throw new GatewayRequestError(409, 'This approval is no longer pending.');
  }
  const result = claimPendingApprovalByApprovalId({
    sessionId,
    approvalId,
    userId,
  });
  if (result.status === 'unauthorized')
    throw new GatewayRequestError(
      403,
      'This approval belongs to another user.',
    );
  if (result.status !== 'claimed')
    throw new GatewayRequestError(409, 'This approval is no longer pending.');
  return result.claim;
}

export function coordinateGatewayApproval(
  execute: (
    request: GatewayChatRequest,
    accept: () => void,
  ) => Promise<GatewayChatResult>,
): (request: GatewayChatRequest) => Promise<GatewayChatResult> {
  return async (request) => {
    const claim = request.approval
      ? claimApprovalResponse(
          request.sessionId,
          request.approval.approvalId,
          request.userId,
          request.approvalClaim,
        )
      : null;
    const executionContext = claim
      ? getPendingApproval(request.sessionId)?.executionContext
      : undefined;
    const resumed = executionContext
      ? { ...request, ...executionContext }
      : request;
    const result = await execute(resumed, () => {
      if (claim && !handoffPendingApprovalClaim(claim))
        throw new GatewayRequestError(
          409,
          'This approval is no longer pending.',
        );
    });
    // OpenAI callers resume via structured /api/chat answers in the same session.
    if (request.channelId === 'openai' && result.pendingApproval) {
      const approval = result.pendingApproval;
      await setPendingApproval(result.sessionId || request.sessionId, {
        approvalId: approval.approvalId,
        prompt: approval.prompt,
        approval,
        userId: request.userId,
        createdAt: Date.now(),
        expiresAt: approval.expiresAt ?? Number.MAX_SAFE_INTEGER,
        executionContext: {
          executionSessionId: resumed.executionSessionId,
          workspacePathOverride: resumed.workspacePathOverride,
          workspaceDisplayRootOverride: resumed.workspaceDisplayRootOverride,
          autoApproveTools: resumed.autoApproveTools,
          executionDeadlineAtMs: resumed.executionDeadlineAtMs,
        },
      });
    }
    return result;
  };
}
