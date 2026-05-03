import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { DEFAULT_RUNTIME_HOME_DIR } from '../config/runtime-paths.js';

export const AGENT_IDENTITY_STATE_VERSION = 1;
export const AGENT_IDENTITY_COMPONENT_MAX_LENGTH = 128;
export const LOCAL_INSTANCE_ID_PREFIX = 'inst-';
export const LOCAL_INSTANCE_ID_MAX_ATTEMPTS = 16;

export interface ParsedAgentIdentity {
  readonly id: string;
  readonly agentSlug: string;
  readonly userSlug: string;
  readonly instanceId: string;
}

export interface LocalInstanceIdState {
  readonly version: typeof AGENT_IDENTITY_STATE_VERSION;
  readonly currentInstanceId: string;
  readonly allocatedInstanceIds: readonly string[];
  readonly allocatedAt: string;
}

export interface ResolveLocalInstanceIdOptions {
  readonly statePath?: string;
  readonly randomUuid?: () => string;
  readonly now?: () => Date;
}

export class AgentIdentityValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: string[]) {
    super(`Invalid agent identity: ${issues.join('; ')}`);
    this.name = 'AgentIdentityValidationError';
    this.issues = [...issues];
  }
}

export class LocalInstanceIdAllocationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocalInstanceIdAllocationError';
  }
}

const AGENT_IDENTITY_COMPONENT_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeAgentIdentityComponent(value: string): string {
  return value.trim().toLowerCase();
}

function validateAgentIdentityComponent(
  label: 'agent slug' | 'user slug' | 'instance id',
  value: string,
  issues: string[],
): void {
  if (!value) {
    issues.push(`${label} is required`);
    return;
  }
  if (!AGENT_IDENTITY_COMPONENT_PATTERN.test(value)) {
    issues.push(
      `${label} must start with a letter or digit and contain only lowercase letters, digits, dots, underscores, or hyphens`,
    );
  }
}

function normalizeAndValidateAgentIdentityParts(
  agentSlug: string,
  userSlug: string,
  instanceId: string,
): ParsedAgentIdentity {
  const normalizedAgentSlug = normalizeAgentIdentityComponent(agentSlug);
  const normalizedUserSlug = normalizeAgentIdentityComponent(userSlug);
  const normalizedInstanceId = normalizeAgentIdentityComponent(instanceId);
  const issues: string[] = [];

  validateAgentIdentityComponent('agent slug', normalizedAgentSlug, issues);
  validateAgentIdentityComponent('user slug', normalizedUserSlug, issues);
  validateAgentIdentityComponent('instance id', normalizedInstanceId, issues);

  if (issues.length > 0) {
    throw new AgentIdentityValidationError(issues);
  }

  return {
    id: `${normalizedAgentSlug}@${normalizedUserSlug}@${normalizedInstanceId}`,
    agentSlug: normalizedAgentSlug,
    userSlug: normalizedUserSlug,
    instanceId: normalizedInstanceId,
  };
}

export function formatAgentIdentity(
  agentSlug: string,
  userSlug: string,
  instanceId: string,
): string {
  return normalizeAndValidateAgentIdentityParts(agentSlug, userSlug, instanceId)
    .id;
}

export function parseAgentIdentity(value: string): ParsedAgentIdentity {
  const normalized = value.trim();

  if (!normalized) {
    throw new AgentIdentityValidationError(['agent identity is required']);
  }

  const parts = normalized.split('@');
  if (parts.length !== 3) {
    throw new AgentIdentityValidationError([
      'agent identity must use the agent-slug@user@instance-id format',
    ]);
  }

  const [agentSlug = '', userSlug = '', instanceId = ''] = parts;
  return normalizeAndValidateAgentIdentityParts(
    agentSlug,
    userSlug,
    instanceId,
  );
}

export function isCanonicalAgentIdentity(value: string): boolean {
  try {
    parseAgentIdentity(value);
    return true;
  } catch {
    return false;
  }
}

export function slugifyAgentIdentityComponent(
  value: string,
  fallback: string,
): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/@.*$/u, '')
    .replace(/[^a-z0-9._-]+/gu, '-')
    .replace(/^[._-]+|[._-]+$/gu, '')
    .slice(0, AGENT_IDENTITY_COMPONENT_MAX_LENGTH);
  if (normalized && AGENT_IDENTITY_COMPONENT_PATTERN.test(normalized)) {
    return normalized;
  }
  return fallback;
}

export function localInstanceIdStatePath(): string {
  return path.join(DEFAULT_RUNTIME_HOME_DIR, 'identity', 'instance-id.json');
}

export function formatLocalInstanceIdFromUuid(uuid: string): string {
  const normalized = uuid.trim().toLowerCase();
  if (!UUID_PATTERN.test(normalized)) {
    throw new AgentIdentityValidationError([
      'instance id UUID must be a valid RFC 4122 UUID',
    ]);
  }
  return `${LOCAL_INSTANCE_ID_PREFIX}${normalized}`;
}

export function allocateUniqueLocalInstanceId(
  allocatedInstanceIds: Iterable<string>,
  randomUuid: () => string = randomUUID,
): string {
  const allocated = new Set(
    Array.from(allocatedInstanceIds, (entry) =>
      normalizeAgentIdentityComponent(entry),
    ),
  );

  for (
    let attempt = 0;
    attempt < LOCAL_INSTANCE_ID_MAX_ATTEMPTS;
    attempt += 1
  ) {
    const candidate = formatLocalInstanceIdFromUuid(randomUuid());
    if (!allocated.has(candidate)) return candidate;
  }

  throw new LocalInstanceIdAllocationError(
    `Failed to allocate a unique local instance id after ${LOCAL_INSTANCE_ID_MAX_ATTEMPTS} attempts.`,
  );
}

function validateLocalInstanceIdState(value: unknown): LocalInstanceIdState {
  if (!isRecord(value)) {
    throw new AgentIdentityValidationError([
      'local instance identity state must be an object',
    ]);
  }

  const issues: string[] = [];
  if (value.version !== AGENT_IDENTITY_STATE_VERSION) {
    issues.push(
      `local instance identity state version must be ${AGENT_IDENTITY_STATE_VERSION}`,
    );
  }
  const currentInstanceId =
    typeof value.currentInstanceId === 'string'
      ? normalizeAgentIdentityComponent(value.currentInstanceId)
      : '';
  validateAgentIdentityComponent('instance id', currentInstanceId, issues);

  const allocatedInstanceIds = Array.isArray(value.allocatedInstanceIds)
    ? value.allocatedInstanceIds
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => normalizeAgentIdentityComponent(entry))
    : [];
  if (!Array.isArray(value.allocatedInstanceIds)) {
    issues.push('allocated instance ids must be an array');
  }
  for (const allocatedId of allocatedInstanceIds) {
    validateAgentIdentityComponent('instance id', allocatedId, issues);
  }
  if (
    currentInstanceId &&
    !new Set(allocatedInstanceIds).has(currentInstanceId)
  ) {
    issues.push('allocated instance ids must include current instance id');
  }

  const allocatedAt =
    typeof value.allocatedAt === 'string' ? value.allocatedAt.trim() : '';
  if (!allocatedAt || Number.isNaN(Date.parse(allocatedAt))) {
    issues.push('allocated at must be an ISO timestamp');
  }

  if (issues.length > 0) {
    throw new AgentIdentityValidationError(issues);
  }

  return {
    version: AGENT_IDENTITY_STATE_VERSION,
    currentInstanceId,
    allocatedInstanceIds: Array.from(new Set(allocatedInstanceIds)),
    allocatedAt,
  };
}

function readLocalInstanceIdState(
  statePath: string,
): LocalInstanceIdState | null {
  try {
    return validateLocalInstanceIdState(
      JSON.parse(fs.readFileSync(statePath, 'utf-8')),
    );
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err?.code === 'ENOENT') return null;
    throw error;
  }
}

function writeNewLocalInstanceIdState(
  statePath: string,
  state: LocalInstanceIdState,
): void {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const fd = fs.openSync(statePath, 'wx');
  try {
    fs.writeFileSync(fd, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
  } finally {
    fs.closeSync(fd);
  }
}

function readEnvInstanceId(): string {
  return slugifyAgentIdentityComponent(
    process.env.HYBRIDCLAW_INSTANCE_ID || '',
    '',
  );
}

export function resolveLocalInstanceId(
  options: ResolveLocalInstanceIdOptions = {},
): string {
  const envInstanceId = readEnvInstanceId();
  if (envInstanceId) return envInstanceId;

  const statePath = options.statePath ?? localInstanceIdStatePath();
  const existingState = readLocalInstanceIdState(statePath);
  if (existingState) return existingState.currentInstanceId;

  const currentInstanceId = allocateUniqueLocalInstanceId(
    [],
    options.randomUuid,
  );
  const allocatedAt = (options.now ?? (() => new Date()))().toISOString();
  const state: LocalInstanceIdState = {
    version: AGENT_IDENTITY_STATE_VERSION,
    currentInstanceId,
    allocatedInstanceIds: [currentInstanceId],
    allocatedAt,
  };

  try {
    writeNewLocalInstanceIdState(statePath, state);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err?.code !== 'EEXIST') throw error;
    const racedState = readLocalInstanceIdState(statePath);
    if (racedState) return racedState.currentInstanceId;
    throw error;
  }

  return currentInstanceId;
}
