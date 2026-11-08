/**
 * Gateway claims coordinate human responses across transports, never tool consent.
 * A failed or interrupted dispatch retains its claim until expiry; restart cannot
 * turn an ambiguous handoff into a retry. The worker validates executable facts.
 */
import { GatewayRequestError } from '../errors/gateway-request-error.js';
import type { GatewayChatRequest, GatewayChatResult } from './gateway-types.js';
import {
  claimPendingApprovalByApprovalId,
  getPendingApproval,
  handoffPendingApprovalClaim,
  isPendingApprovalClaim,
  type PendingApprovalClaim,
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
    return execute(request, () => {
      if (claim && !handoffPendingApprovalClaim(claim))
        throw new GatewayRequestError(
          409,
          'This approval is no longer pending.',
        );
    });
  };
}
