import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { DEFAULT_RUNTIME_HOME_DIR } from '../config/runtime-paths.js';

export const AGENT_IDENTITY_COMPONENT_MAX_LENGTH = 128;
export const LOCAL_INSTANCE_ID_PREFIX = 'inst-';

let cachedDefaultInstanceId: string | undefined;
let cachedDefaultInstanceEnvValue: string | undefined;

export interface ParsedAgentIdentity {
  readonly id: string;
  readonly agentSlug: string;
  readonly userSlug: string;
  readonly instanceId: string;
}

export interface LocalInstanceIdState {
  readonly currentInstanceId: string;
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
  const parts = value.trim().toLowerCase().split('@');
  return (
    parts.length === 3 &&
    parts.every((part) => AGENT_IDENTITY_COMPONENT_PATTERN.test(part))
  );
}

export function slugifyAgentIdentityComponent(
  value: string,
  fallback: string,
): string {
  const normalized = normalizeAgentIdentityComponent(value)
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

function allocateLocalInstanceId(
  randomUuid: () => string = randomUUID,
): string {
  return formatLocalInstanceIdFromUuid(randomUuid());
}

function validateLocalInstanceIdState(value: unknown): LocalInstanceIdState {
  if (!isRecord(value)) {
    throw new AgentIdentityValidationError([
      'local instance identity state must be an object',
    ]);
  }

  const issues: string[] = [];
  const currentInstanceId =
    typeof value.currentInstanceId === 'string'
      ? normalizeAgentIdentityComponent(value.currentInstanceId)
      : '';
  validateAgentIdentityComponent('instance id', currentInstanceId, issues);

  const allocatedAt =
    typeof value.allocatedAt === 'string' ? value.allocatedAt.trim() : '';
  if (!allocatedAt || Number.isNaN(Date.parse(allocatedAt))) {
    issues.push('allocated at must be an ISO timestamp');
  }

  if (issues.length > 0) {
    throw new AgentIdentityValidationError(issues);
  }

  return {
    currentInstanceId,
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
  const stateDir = path.dirname(statePath);
  fs.mkdirSync(stateDir, { recursive: true });
  const tempPath = path.join(stateDir, `.instance-id-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: 'utf-8',
      flag: 'wx',
    });
    // Hard-linking creates the target only after the complete temp file exists
    // and fails with EEXIST instead of overwriting a concurrently-created id.
    fs.linkSync(tempPath, statePath);
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
}

export function resolveLocalInstanceId(
  options: ResolveLocalInstanceIdOptions = {},
): string {
  const cacheable =
    options.statePath === undefined &&
    options.randomUuid === undefined &&
    options.now === undefined;
  const envValue = process.env.HYBRIDCLAW_INSTANCE_ID || '';
  const envInstanceId = slugifyAgentIdentityComponent(envValue, '');
  if (
    cacheable &&
    cachedDefaultInstanceId &&
    cachedDefaultInstanceEnvValue === envValue
  ) {
    return cachedDefaultInstanceId;
  }

  if (envInstanceId) {
    if (cacheable) {
      cachedDefaultInstanceId = envInstanceId;
      cachedDefaultInstanceEnvValue = envValue;
    }
    return envInstanceId;
  }

  const statePath = options.statePath ?? localInstanceIdStatePath();
  const existingState = readLocalInstanceIdState(statePath);
  if (existingState) {
    if (cacheable) {
      cachedDefaultInstanceId = existingState.currentInstanceId;
      cachedDefaultInstanceEnvValue = envValue;
    }
    return existingState.currentInstanceId;
  }

  const currentInstanceId = allocateLocalInstanceId(options.randomUuid);
  const allocatedAt = (options.now ?? (() => new Date()))().toISOString();
  const state: LocalInstanceIdState = {
    currentInstanceId,
    allocatedAt,
  };

  try {
    writeNewLocalInstanceIdState(statePath, state);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err?.code !== 'EEXIST') throw error;
    const racedState = readLocalInstanceIdState(statePath);
    if (racedState) {
      if (cacheable) {
        cachedDefaultInstanceId = racedState.currentInstanceId;
        cachedDefaultInstanceEnvValue = envValue;
      }
      return racedState.currentInstanceId;
    }
    throw new LocalInstanceIdAllocationError(
      'Local instance id state file was created by another process but was missing on read; state directory may be unstable.',
    );
  }

  if (cacheable) {
    cachedDefaultInstanceId = currentInstanceId;
    cachedDefaultInstanceEnvValue = envValue;
  }
  return currentInstanceId;
}
