/** Dashboard decisions enter with the host token and resume the durable owning chat. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { WEB_API_TOKEN } from '../config/config.js';
import { GatewayRequestError } from '../errors/gateway-request-error.js';
import { safeEqualToken } from './auth-token.js';
import { rememberChatApproval } from './chat-approval-review.js';
import {
  claimConnectorDecision,
  connectorDecisionRequest,
} from './connector-approval.js';
import { handleGatewayMessage } from './gateway-chat-service.js';
import { readJsonBody, sendJson } from './gateway-http-utils.js';
import { notifyWebSession } from './web-notifications.js';
export async function handleConnectorDecision(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (
    !WEB_API_TOKEN ||
    !safeEqualToken(req.headers.authorization || '', `Bearer ${WEB_API_TOKEN}`)
  )
    throw new GatewayRequestError(403, 'Host authentication required.');
  const request = connectorDecisionRequest(await readJsonBody(req));
  claimConnectorDecision(
    request.sessionId,
    request.approval.approvalId,
    request.userId,
  );
  const result = await handleGatewayMessage(request);
  await rememberChatApproval(request, result);
  notifyWebSession(
    request.sessionId,
    'turn',
    String(result.assistantMessageId || ''),
  );
  sendJson(res, 200, { status: result.status });
}
