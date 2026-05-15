import {
  handleRemotePolicyUpdate,
  type PolicyUpdatePrincipal,
  type PolicyUpdateResult,
} from '../policy/remote-policy-authority.js';
import type { A2AEnvelope } from './envelope.js';
import { type A2ADeliveryConfirmation, sendMessage } from './runtime.js';

export interface A2AInboundPipelineMeta {
  actor: string;
  source: 'a2a' | 'webhook';
  sessionId?: string;
  auditRunId?: string;
  policyUpdatePrincipal?: PolicyUpdatePrincipal;
  workspacePath?: string;
}

export function acceptA2AInboundEnvelope(
  envelope: A2AEnvelope,
  meta: A2AInboundPipelineMeta,
): A2ADeliveryConfirmation | PolicyUpdateResult {
  if (envelope.intent === 'policy.update') {
    if (!meta.policyUpdatePrincipal) {
      return {
        disposition: 'rejected',
        updateId: envelope.id,
        diff: [],
        statusCode: 403,
        reason: 'missing policy update principal',
      };
    }
    if (!meta.workspacePath) {
      throw new Error('policy.update requires workspacePath');
    }
    return handleRemotePolicyUpdate({
      workspacePath: meta.workspacePath,
      content: envelope.content,
      principal: meta.policyUpdatePrincipal,
    });
  }
  return sendMessage(envelope, {
    actor: `${meta.source}:${meta.actor}`,
    auditRole: 'receiver',
    sessionId: meta.sessionId,
    auditRunId: meta.auditRunId,
  });
}
