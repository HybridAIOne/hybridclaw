import type { A2AEnvelope } from './envelope.js';
import { type A2ADeliveryConfirmation, sendMessage } from './runtime.js';
import {
  handleRemotePolicyUpdate,
  type PolicyUpdatePrincipal,
  type PolicyUpdateResult,
} from '../policy/remote-policy-authority.js';

export interface A2AInboundPipelineMeta {
  actor: string;
  source: 'webhook';
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
        reason: 'missing policy update principal',
      };
    }
    return handleRemotePolicyUpdate({
      workspacePath: meta.workspacePath || process.cwd(),
      content: envelope.content,
      principal: meta.policyUpdatePrincipal,
    });
  }
  return sendMessage(envelope, {
    actor: `${meta.source}:${meta.actor}`,
    sessionId: meta.sessionId,
    auditRunId: meta.auditRunId,
  });
}
