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

export function isUserActor(value: unknown): value is UserActor {
  if (!isRecord(value) || value.type !== 'user') return false;
  try {
    if (typeof value.id !== 'string') return false;
    createUserActor(value.id);
    return true;
  } catch {
    return false;
  }
}

export function isAgentActor(value: unknown): value is AgentActor {
  if (!isRecord(value) || value.type !== 'agent') return false;
  try {
    if (typeof value.id !== 'string') return false;
    createAgentActor(value.id);
    return true;
  } catch {
    return false;
  }
}

export function serializeActor(actor: Actor): string {
  const normalized = normalizeActor(actor);
  return `${normalized.type}:${normalized.id}`;
}

export function parseActor(value: string): Actor {
  const raw = value.trim();
  if (!raw) throw new ActorValidationError(['actor is required']);
  if (raw.startsWith('{')) {
    try {
      return normalizeActor(JSON.parse(raw) as unknown);
    } catch (error) {
      if (error instanceof ActorValidationError) throw error;
      throw new ActorValidationError([
        `actor JSON is invalid: ${
          error instanceof Error ? error.message : 'unknown parse error'
        }`,
      ]);
    }
  }

  const separator = raw.indexOf(':');
  if (separator <= 0) {
    throw new ActorValidationError([
      'actor must use the type:id serialized format',
    ]);
  }
  return createActor(
    normalizeActorType(raw.slice(0, separator)),
    raw.slice(separator + 1),
  );
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
