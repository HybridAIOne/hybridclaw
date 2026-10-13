/** Human chat decisions cross the connector boundary with a host-only proof. */
import { createHmac } from 'node:crypto';
import { platformApprovalId } from '../../container/shared/connector-approval.js';
import { getHybridAIApiKey } from '../auth/hybridai-auth.js';
import { HYBRIDAI_BASE_URL, WEB_API_TOKEN } from '../config/config.js';
import { GatewayRequestError } from '../errors/gateway-request-error.js';
import { memoryService } from '../memory/memory-service.js';
import type { GatewayApprovalAnswer } from './approval-answer.js';
import { approvalAnswerText } from './approval-answer.js';
import type { GatewayChatRequest } from './gateway-types.js';
import {
  claimPendingApprovalByApprovalId,
  getPendingApproval,
} from './pending-approvals.js';

export function connectorPending(sessionId: string, approvalId: string) {
  const pending = getPendingApproval(sessionId);
  if (
    !pending ||
    pending.approvalId !== approvalId ||
    pending.resolvedAt ||
    pending.expiresAt <= Date.now()
  )
    throw new GatewayRequestError(409, 'This approval is no longer pending.');
  return pending;
}

export async function forwardConnectorDecision(
  answer: GatewayApprovalAnswer,
  sessionId: string,
  userId: string,
): Promise<void> {
  const id = platformApprovalId(answer.approvalId);
  if (!id) return;
  const pending = connectorPending(sessionId, answer.approvalId);
  if (pending.userId !== userId)
    throw new GatewayRequestError(
      403,
      'This approval belongs to another user.',
    );
  if (answer.decision !== 'yes' && answer.decision !== 'no')
    throw new GatewayRequestError(
      400,
      'Each connector change needs a one-shot approval.',
    );
  if (!WEB_API_TOKEN)
    throw new GatewayRequestError(
      503,
      'The connector approval bridge is unavailable.',
    );
  const decision = answer.decision === 'yes' ? 'approve' : 'deny';
  const timestamp = Math.floor(Date.now() / 1000);
  const proof = createHmac('sha256', WEB_API_TOKEN)
    .update(`hy-connector-approval-v1\n${timestamp}\n${id}\n${decision}`)
    .digest('hex');
  const response = await fetch(
    `${HYBRIDAI_BASE_URL.replace(/\/+$/, '')}/api/v1/connectors/approvals/${id}/runtime`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${getHybridAIApiKey()}`,
        'Content-Type': 'application/json',
        'X-Hy-Approval-Proof': proof,
      },
      body: JSON.stringify({ decision, timestamp }),
      signal: AbortSignal.timeout(15000),
    },
  );
  if (!response.ok)
    throw new GatewayRequestError(
      502,
      'The connector approval could not be saved. Try again.',
    );
  claimConnectorDecision(sessionId, answer.approvalId, userId);
}

export function connectorDecisionRequest(
  value: unknown,
): GatewayChatRequest & { approval: GatewayApprovalAnswer } {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new GatewayRequestError(400, 'Invalid connector decision.');
  const body = value as Record<string, unknown>;
  if (
    typeof body.sessionId !== 'string' ||
    typeof body.approvalId !== 'string' ||
    !platformApprovalId(body.approvalId) ||
    !['approve', 'deny'].includes(String(body.decision))
  )
    throw new GatewayRequestError(400, 'Invalid connector decision.');
  const pending = connectorPending(body.sessionId, body.approvalId);
  const agentId = memoryService.getSessionById(body.sessionId)?.agent_id;
  if (!agentId)
    throw new GatewayRequestError(
      409,
      'The approval chat is no longer available.',
    );
  const approval = {
    approvalId: body.approvalId,
    decision: body.decision === 'approve' ? ('yes' as const) : ('no' as const),
  };
  return {
    sessionId: body.sessionId,
    channelId: 'web',
    sessionMode: 'resume',
    guildId: null,
    userId: pending.userId,
    agentId,
    username: 'web',
    content: approvalAnswerText(approval),
    approval,
    client: 'mobile',
  };
}

export function claimConnectorDecision(
  sessionId: string,
  approvalId: string,
  userId: string,
): void {
  const claim = claimPendingApprovalByApprovalId({ approvalId, userId });
  if (claim.status !== 'claimed' || claim.sessionId !== sessionId)
    throw new GatewayRequestError(409, 'This approval is no longer pending.');
}
