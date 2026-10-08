import { parseAgentIdentity } from './agent-id.js';
import { parseUserId } from './user-id.js';

export type ActorType = 'user' | 'agent';

export interface UserActor {
  readonly type: 'user';
  readonly id: string;
}

export interface AgentActor {
  readonly type: 'agent';
  readonly id: string;
}

export type Actor = UserActor | AgentActor;

export class ActorValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: string[]) {
    super(`Invalid actor: ${issues.join('; ')}`);
    this.name = 'ActorValidationError';
    this.issues = [...issues];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeActorType(value: unknown): ActorType {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (normalized === 'user' || normalized === 'agent') return normalized;
  throw new ActorValidationError(['type must be user or agent']);
}

function normalizeActorId(type: ActorType, id: unknown): string {
  const value = typeof id === 'string' ? id.trim() : '';
  if (!value) throw new ActorValidationError(['id is required']);
  try {
    return type === 'user'
      ? parseUserId(value).id
      : parseAgentIdentity(value).id;
  } catch (error) {
    throw new ActorValidationError([
      error instanceof Error ? error.message : 'invalid id',
    ]);
  }
}

export function createUserActor(id: string): UserActor {
  return { type: 'user', id: normalizeActorId('user', id) };
}

export function createAgentActor(id: string): AgentActor {
  return { type: 'agent', id: normalizeActorId('agent', id) };
}

export function createActor(type: ActorType, id: string): Actor {
  return type === 'user' ? createUserActor(id) : createAgentActor(id);
}

export function normalizeActor(value: unknown): Actor {
  if (!isRecord(value)) {
    throw new ActorValidationError(['actor must be an object']);
  }
  const type = normalizeActorType(value.type);
  return createActor(type, normalizeActorId(type, value.id));
}

export function actorFromLegacyFields(params: {
  readonly userId?: string | null;
  readonly agentId?: string | null;
}): Actor | null {
  const userId = params.userId?.trim() || '';
  const agentId = params.agentId?.trim() || '';
  if (userId && agentId) {
    throw new ActorValidationError([
      'actor must reference either userId or agentId, not both',
    ]);
  }
  if (userId) return createUserActor(userId);
  if (agentId) return createAgentActor(agentId);
  return null;
}
