/**
 * Host execution may target a task directory; agent state stays with its owner.
 * A scope owns its own state, never the main agent's or another scope's files.
 * Unlike runtime-paths this resolves gateway-owned host paths, not tool access.
 */
import path from 'node:path';
import { DEFAULT_AGENT_ID } from '../agents/agent-types.js';
import { sessionWorkspaceDir } from '../scopes/scope-paths.js';

export function hostWorkspaceStateRoot(params: {
  agentId?: string;
  runtimeScope?: { agentId: string; scopeId: string };
}): string {
  if (
    params.runtimeScope &&
    params.agentId &&
    params.runtimeScope.agentId !== params.agentId
  )
    throw new Error('Worker state scope must belong to the executing agent');
  return path.resolve(
    sessionWorkspaceDir({
      agent_id:
        params.agentId || params.runtimeScope?.agentId || DEFAULT_AGENT_ID,
      scope: params.runtimeScope?.scopeId,
    }),
  );
}
