import path from 'node:path';

import {
  getRuntimeAssetRevision,
  getRuntimeAssetRevisionState,
  listRuntimeAssetRevisions,
  type RuntimeConfigChangeMeta,
  type RuntimeConfigRevisionSummary,
  syncRuntimeAssetRevisionState,
} from '../config/runtime-config-revisions.js';
import { DEFAULT_RUNTIME_HOME_DIR } from '../config/runtime-paths.js';
import { md5Hex } from '../utils/hash.js';
import type { AgentConfig } from './agent-types.js';
import {
  type AgentTeamStructureDiff,
  type AgentTeamStructureSnapshot,
  agentTeamStructureDiffCount,
  diffAgentTeamStructureSnapshots,
  parseAgentTeamStructureSnapshot,
  serializeAgentTeamStructure,
} from './team-structure.js';

export interface AgentTeamStructureRevisionSummary
  extends RuntimeConfigRevisionSummary {
  diff: AgentTeamStructureDiff;
  changeCount: number;
}

export interface AgentTeamStructureRevision
  extends AgentTeamStructureRevisionSummary {
  snapshot: AgentTeamStructureSnapshot;
}

const AGENT_TEAM_STRUCTURE_ASSET_PATH = path.join(
  DEFAULT_RUNTIME_HOME_DIR,
  'agents',
  'team-structure.json',
);

export function agentTeamStructureAssetPath(): string {
  return AGENT_TEAM_STRUCTURE_ASSET_PATH;
}

function revisionNextContent(params: {
  revision: RuntimeConfigRevisionSummary;
  revisions: RuntimeConfigRevisionSummary[];
  currentContent: string;
}): string | null {
  if (!params.revision.replacedByMd5) return null;
  // Runtime revisions link forward by storing the MD5 of the content that replaced this revision.
  if (md5Hex(params.currentContent) === params.revision.replacedByMd5) {
    return params.currentContent;
  }
  const nextRevision = params.revisions.find(
    (candidate) => candidate.md5 === params.revision.replacedByMd5,
  );
  if (!nextRevision) return null;
  const record = getRuntimeAssetRevision(
    'team',
    AGENT_TEAM_STRUCTURE_ASSET_PATH,
    nextRevision.id,
  );
  return record?.content ?? null;
}

function summarizeRevision(params: {
  revision: RuntimeConfigRevisionSummary;
  revisions: RuntimeConfigRevisionSummary[];
  currentContent: string;
}): AgentTeamStructureRevisionSummary {
  const record = getRuntimeAssetRevision(
    'team',
    AGENT_TEAM_STRUCTURE_ASSET_PATH,
    params.revision.id,
  );
  if (!record) {
    throw new Error(
      `Team structure revision ${params.revision.id} was not found.`,
    );
  }
  const snapshot = parseAgentTeamStructureSnapshot(record.content);
  const nextContent = revisionNextContent(params);
  const nextSnapshot = nextContent
    ? parseAgentTeamStructureSnapshot(nextContent)
    : snapshot;
  const diff = diffAgentTeamStructureSnapshots(snapshot, nextSnapshot);
  return {
    ...params.revision,
    diff,
    changeCount: agentTeamStructureDiffCount(diff),
  };
}

export function syncAgentTeamStructureRevisionState(
  agents: AgentConfig[],
  meta?: RuntimeConfigChangeMeta,
): { changed: boolean; previousMd5: string | null; currentMd5: string | null } {
  const content = serializeAgentTeamStructure(agents);
  return syncRuntimeAssetRevisionState(
    'team',
    AGENT_TEAM_STRUCTURE_ASSET_PATH,
    meta,
    {
      exists: true,
      content,
    },
  );
}

export function listAgentTeamStructureRevisions(
  currentAgents: AgentConfig[],
): AgentTeamStructureRevisionSummary[] {
  const revisions = listRuntimeAssetRevisions(
    'team',
    AGENT_TEAM_STRUCTURE_ASSET_PATH,
  );
  const currentContent =
    getRuntimeAssetRevisionState('team', AGENT_TEAM_STRUCTURE_ASSET_PATH)
      ?.content ?? serializeAgentTeamStructure(currentAgents);
  return revisions.map((revision) =>
    summarizeRevision({ revision, revisions, currentContent }),
  );
}

export function getAgentTeamStructureRevision(
  revisionId: number,
  currentAgents: AgentConfig[],
): AgentTeamStructureRevision {
  const revisions = listRuntimeAssetRevisions(
    'team',
    AGENT_TEAM_STRUCTURE_ASSET_PATH,
  );
  const summary = revisions.find((revision) => revision.id === revisionId);
  if (!summary) {
    throw new Error(`Team structure revision ${revisionId} was not found.`);
  }
  const record = getRuntimeAssetRevision(
    'team',
    AGENT_TEAM_STRUCTURE_ASSET_PATH,
    revisionId,
  );
  if (!record) {
    throw new Error(`Team structure revision ${revisionId} was not found.`);
  }
  const currentContent =
    getRuntimeAssetRevisionState('team', AGENT_TEAM_STRUCTURE_ASSET_PATH)
      ?.content ?? serializeAgentTeamStructure(currentAgents);
  const nextContent = revisionNextContent({
    revision: summary,
    revisions,
    currentContent,
  });
  const snapshot = parseAgentTeamStructureSnapshot(record.content);
  const nextSnapshot = nextContent
    ? parseAgentTeamStructureSnapshot(nextContent)
    : null;
  const diff = diffAgentTeamStructureSnapshots(
    snapshot,
    nextSnapshot ?? snapshot,
  );
  return {
    ...summary,
    diff,
    changeCount: agentTeamStructureDiffCount(diff),
    snapshot,
  };
}
