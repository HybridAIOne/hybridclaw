import { normalizeOptionalTrimmedUniqueStringArray } from '../utils/normalized-strings.js';
import { isRecord } from '../utils/type-guards.js';
import type { AgentConfig } from './agent-types.js';
import { validateAgentOrgChart } from './agent-types.js';

export const AGENT_TEAM_STRUCTURE_VERSION = 1;

export type AgentTeamStructureField =
  | 'role'
  | 'reportsTo'
  | 'delegatesTo'
  | 'peers';

export interface AgentTeamStructureEntry {
  id: string;
  role?: string;
  reportsTo?: string;
  delegatesTo?: string[];
  peers?: string[];
}

export interface AgentTeamStructureSnapshot {
  version: typeof AGENT_TEAM_STRUCTURE_VERSION;
  agents: AgentTeamStructureEntry[];
}

export interface AgentTeamStructureFieldDiff {
  field: AgentTeamStructureField;
  before: string | string[] | null;
  after: string | string[] | null;
}

export interface AgentTeamStructureAgentDiff {
  agentId: string;
  fields: AgentTeamStructureFieldDiff[];
}

export interface AgentTeamStructureDiff {
  added: AgentTeamStructureEntry[];
  removed: AgentTeamStructureEntry[];
  changed: AgentTeamStructureAgentDiff[];
}

export interface AgentTeamStructureSnapshotOptions {
  validate?: boolean;
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeTeamEntry(value: unknown): AgentTeamStructureEntry | null {
  if (!isRecord(value)) return null;
  const id = normalizeString(value.id);
  if (!id) return null;
  const role = normalizeString(value.role);
  const reportsTo = normalizeString(value.reportsTo);
  const delegatesTo = normalizeOptionalTrimmedUniqueStringArray(
    value.delegatesTo,
  );
  const peers = normalizeOptionalTrimmedUniqueStringArray(value.peers);
  return {
    id,
    ...(role ? { role } : {}),
    ...(reportsTo ? { reportsTo } : {}),
    ...(delegatesTo ? { delegatesTo } : {}),
    ...(peers ? { peers } : {}),
  };
}

function toAgentConfig(entry: AgentTeamStructureEntry): AgentConfig {
  return {
    id: entry.id,
    ...(entry.role ? { role: entry.role } : {}),
    ...(entry.reportsTo ? { reportsTo: entry.reportsTo } : {}),
    ...(entry.delegatesTo ? { delegatesTo: [...entry.delegatesTo] } : {}),
    ...(entry.peers ? { peers: [...entry.peers] } : {}),
  };
}

function snapshotEntry(agent: AgentConfig): AgentTeamStructureEntry {
  const role = normalizeString(agent.role);
  const reportsTo = normalizeString(agent.reportsTo);
  const delegatesTo = normalizeOptionalTrimmedUniqueStringArray(
    agent.delegatesTo,
  );
  const peers = normalizeOptionalTrimmedUniqueStringArray(agent.peers);
  return {
    id: agent.id.trim(),
    ...(role ? { role } : {}),
    ...(reportsTo ? { reportsTo } : {}),
    ...(delegatesTo ? { delegatesTo } : {}),
    ...(peers ? { peers } : {}),
  };
}

export function buildAgentTeamStructureSnapshot(
  agents: AgentConfig[],
  options?: AgentTeamStructureSnapshotOptions,
): AgentTeamStructureSnapshot {
  const seen = new Set<string>();
  const entries: AgentTeamStructureEntry[] = [];
  for (const agent of agents) {
    const id = agent.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    entries.push(snapshotEntry(agent));
  }
  entries.sort((left, right) => left.id.localeCompare(right.id));
  if (options?.validate !== false) {
    validateAgentOrgChart(entries.map(toAgentConfig));
  }
  return {
    version: AGENT_TEAM_STRUCTURE_VERSION,
    agents: entries,
  };
}

export function parseAgentTeamStructureSnapshot(
  raw: string,
): AgentTeamStructureSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(
      `Team structure revision is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!isRecord(parsed)) {
    throw new Error('Team structure revision must be a JSON object.');
  }
  if (parsed.version !== AGENT_TEAM_STRUCTURE_VERSION) {
    throw new Error(
      `Team structure revision version must be ${AGENT_TEAM_STRUCTURE_VERSION}.`,
    );
  }
  if (!Array.isArray(parsed.agents)) {
    throw new Error('Team structure revision must include an agents array.');
  }

  const seen = new Set<string>();
  const agents: AgentTeamStructureEntry[] = [];
  for (const entry of parsed.agents) {
    const normalized = normalizeTeamEntry(entry);
    if (!normalized) {
      throw new Error('Team structure revision contains an invalid agent.');
    }
    if (seen.has(normalized.id)) {
      throw new Error(
        `Team structure revision contains duplicate agent "${normalized.id}".`,
      );
    }
    seen.add(normalized.id);
    agents.push(normalized);
  }
  agents.sort((left, right) => left.id.localeCompare(right.id));
  validateAgentOrgChart(agents.map(toAgentConfig));
  return {
    version: AGENT_TEAM_STRUCTURE_VERSION,
    agents,
  };
}

export function serializeAgentTeamStructureSnapshot(
  snapshot: AgentTeamStructureSnapshot,
): string {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

export function serializeAgentTeamStructure(
  agents: AgentConfig[],
  options?: AgentTeamStructureSnapshotOptions,
): string {
  return serializeAgentTeamStructureSnapshot(
    buildAgentTeamStructureSnapshot(agents, options),
  );
}

function valuesEqual(
  left: string | string[] | null,
  right: string | string[] | null,
): boolean {
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    return left.length === right.length && left.every((v, i) => v === right[i]);
  }
  return left === right;
}

function getFieldValue(
  entry: AgentTeamStructureEntry,
  field: AgentTeamStructureField,
): string | string[] | null {
  const value = entry[field];
  if (Array.isArray(value)) return [...value];
  return value || null;
}

export function diffAgentTeamStructureSnapshots(
  before: AgentTeamStructureSnapshot,
  after: AgentTeamStructureSnapshot,
): AgentTeamStructureDiff {
  const beforeById = new Map(before.agents.map((agent) => [agent.id, agent]));
  const afterById = new Map(after.agents.map((agent) => [agent.id, agent]));
  const fields: AgentTeamStructureField[] = [
    'role',
    'reportsTo',
    'delegatesTo',
    'peers',
  ];
  const changed: AgentTeamStructureAgentDiff[] = [];

  for (const [agentId, beforeAgent] of beforeById) {
    const afterAgent = afterById.get(agentId);
    if (!afterAgent) continue;
    const fieldDiffs = fields
      .map((field) => ({
        field,
        before: getFieldValue(beforeAgent, field),
        after: getFieldValue(afterAgent, field),
      }))
      .filter((diff) => !valuesEqual(diff.before, diff.after));
    if (fieldDiffs.length > 0) {
      changed.push({ agentId, fields: fieldDiffs });
    }
  }

  return {
    added: after.agents.filter((agent) => !beforeById.has(agent.id)),
    removed: before.agents.filter((agent) => !afterById.has(agent.id)),
    changed,
  };
}

export function agentTeamStructureDiffCount(
  diff: AgentTeamStructureDiff,
): number {
  return diff.added.length + diff.removed.length + diff.changed.length;
}
