/**
 * The gateway credential handed to agent runtimes: worker processes, task
 * containers and the shells and skill scripts they spawn. It claims only
 * `agent.runtime`, so it reaches the routes agent tools call back into and
 * nothing operator-facing.
 *
 * It is an HMAC of `GATEWAY_API_TOKEN`, not a secret of its own: every process
 * that can authenticate as the operator (the gateway, a CLI command running an
 * agent) derives the same value without storing anything, a runtime holding it
 * cannot recover the operator token, and rotating `GATEWAY_API_TOKEN` rotates
 * it. Spawners derive from `ensureGatewayApiTokenPersisted()`, so a generated
 * fallback token reaches the secret store before any process derives from it.
 *
 * A scoped chat's worker gets its own variant, bound to its agent and scope
 * (`deriveScopeRuntimeToken`): the same claim, but the gateway then accepts
 * callbacks only for that scope's chats (`scope-runtime-auth.ts`).
 *
 * NOT a scoped `hck_` API token (`api-tokens.ts`): it has no stored row, so
 * operators cannot list, issue, or revoke it apart from rotating the source.
 */
import { createHmac } from 'node:crypto';
import { ensureGatewayApiTokenPersisted } from '../config/config.js';

const AGENT_RUNTIME_TOKEN_CONTEXT = 'hybridclaw-agent-runtime-v1';
const SCOPE_RUNTIME_TOKEN_CONTEXT = 'hybridclaw-agent-runtime-scope-v1';

export const AGENT_RUNTIME_TOKEN_CLAIMS: Readonly<Record<string, unknown>> =
  Object.freeze({ actions: Object.freeze(['agent.runtime']) });

/** An empty source yields no token, never a publicly computable one. */
export function deriveAgentRuntimeToken(gatewayApiToken: string): string {
  const source = gatewayApiToken.trim();
  if (!source) return '';
  return createHmac('sha256', source)
    .update(AGENT_RUNTIME_TOKEN_CONTEXT)
    .digest('hex');
}

/** The token a spawner hands to the agent runtimes it starts. */
export function resolveAgentRuntimeToken(): string {
  return deriveAgentRuntimeToken(ensureGatewayApiTokenPersisted());
}

/** The runtime token of a scope's workers; empty without a source token. */
export function deriveScopeRuntimeToken(
  gatewayApiToken: string,
  agentId: string,
  scopeId: string,
): string {
  const source = gatewayApiToken.trim();
  if (!source) return '';
  return createHmac('sha256', source)
    .update(`${SCOPE_RUNTIME_TOKEN_CONTEXT}\0${agentId}\0${scopeId}`)
    .digest('hex');
}

/** The token a spawner hands to a worker; scoped when the run is. */
export function resolveWorkerRuntimeToken(
  scope: { agentId: string; scopeId: string } | undefined,
): string {
  return scope
    ? deriveScopeRuntimeToken(
        ensureGatewayApiTokenPersisted(),
        scope.agentId,
        scope.scopeId,
      )
    : resolveAgentRuntimeToken();
}
