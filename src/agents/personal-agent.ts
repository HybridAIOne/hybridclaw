/**
 * Personal agents — one-person children of a shared parent agent.
 *
 * A personal agent carries only its identity and workspace; every runtime
 * setting resolves from the parent through `extends`, so editing the parent
 * changes all of its children at once. Creation is idempotent per id and
 * never overwrites an existing agent.
 *
 * NOT the routing layer (channels decide which person maps to which agent)
 * and NOT the registry (which owns validation and persistence).
 */
import { seedWorkspaceFromAgent } from '../workspace.js';
import {
  getAgentById,
  listAgents,
  upsertRegisteredAgent,
} from './agent-registry.js';
import type { AgentConfig } from './agent-types.js';
import { sanitizeClawAgentId } from './claw-manifest.js';

export interface CreatePersonalAgentParams {
  parentAgentId: string;
  /** Human-readable handle used to derive the agent id, e.g. a display name. */
  handle: string;
  displayName: string;
  /** Contents of the child's USER.md. */
  userMarkdown: string;
}

export function resolvePersonalAgentParent(parentAgentId: string): AgentConfig {
  const parent = getAgentById(parentAgentId.trim());
  if (!parent || parent.archived) {
    throw new Error(
      `Personal agents need an existing, active parent agent; "${parentAgentId}" is not one.`,
    );
  }
  if (parent.extends) {
    throw new Error(
      `Agent "${parent.id}" is itself a personal agent and cannot be a parent.`,
    );
  }
  return parent;
}

function allocatePersonalAgentId(parentId: string, handle: string): string {
  const slug = sanitizeClawAgentId(handle, 'user').replace(/-+$/, '');
  const base = `${parentId}-${slug}`.slice(0, 64);
  const taken = new Set(listAgents().map((agent) => agent.id));
  if (!taken.has(base)) return base;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base}-${index}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error(`Could not allocate a personal agent id under "${base}".`);
}

export function createPersonalAgent(
  params: CreatePersonalAgentParams,
): AgentConfig {
  const parent = resolvePersonalAgentParent(params.parentAgentId);
  const id = allocatePersonalAgentId(parent.id, params.handle);
  const created = upsertRegisteredAgent({
    id,
    extends: parent.id,
    displayName: params.displayName.trim() || id,
  });
  seedWorkspaceFromAgent({
    agentId: created.id,
    sourceAgentId: parent.id,
    userMarkdown: params.userMarkdown,
  });
  return created;
}
