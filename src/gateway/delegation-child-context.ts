/**
 * Each live delegated child owns its callback context under its exact ID.
 * Scope and routing exist only while that child's agent call is running, unlike the
 * durable parent session; sibling prefixes and finished children never match.
 */
import type { RuntimeScope } from '../scopes/scope-runtime-auth.js';

export interface DelegationChildContext {
  channelId: string;
  chatbotId: string;
  enableRag: boolean;
  agentId: string;
  model: string;
  runtimeScope?: RuntimeScope;
}

const activeChildren = new Map<string, Readonly<DelegationChildContext>>();

export function getActiveDelegationChildContext(
  sessionId: string,
): Readonly<DelegationChildContext> | undefined {
  return activeChildren.get(sessionId);
}

export async function withDelegationChildContext<T>(
  sessionId: string,
  context: DelegationChildContext,
  run: () => Promise<T>,
): Promise<T> {
  if (activeChildren.has(sessionId)) {
    throw new Error('Delegated child already has an active context.');
  }
  activeChildren.set(sessionId, context);
  try {
    return await run();
  } finally {
    activeChildren.delete(sessionId);
  }
}
