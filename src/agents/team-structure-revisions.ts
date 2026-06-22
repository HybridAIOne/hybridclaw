import path from 'node:path';

import {
  getRuntimeAssetRevisionDetailHistory,
  listRuntimeAssetRevisionHistory,
  type RuntimeConfigChangeMeta,
  type RuntimeConfigRevision,
  type RuntimeConfigRevisionSummary,
  syncRuntimeAssetRevisionState,
} from '../config/runtime-config-revisions.js';
import { DEFAULT_RUNTIME_HOME_DIR } from '../config/runtime-paths.js';
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
  revision: RuntimeConfigRevision;
  revisions: RuntimeConfigRevision[];
  currentContent: string;
  currentMd5: string | null;
}): string | null {
  if (!params.revision.replacedByMd5) return null;
  // Runtime revisions link forward by storing the revision token that replaced this revision.
  if (params.currentMd5 === params.revision.replacedByMd5) {
    return params.currentContent;
  }
  const nextRevision = params.revisions.find(
    (candidate) => candidate.md5 === params.revision.replacedByMd5,
  );
  return nextRevision?.content ?? null;
}

function summarizeRevision(params: {
  revision: RuntimeConfigRevision;
  revisions: RuntimeConfigRevision[];
  currentContent: string;
  currentMd5: string | null;
}): AgentTeamStructureRevisionSummary {
  const snapshot = parseAgentTeamStructureSnapshot(params.revision.content);
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
  const content = serializeAgentTeamStructure(agents, { validate: false });
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
  const history = listRuntimeAssetRevisionHistory(
    'team',
    AGENT_TEAM_STRUCTURE_ASSET_PATH,
  );
  const currentContent =
    history.state?.content ??
    serializeAgentTeamStructure(currentAgents, { validate: false });
  return history.revisions.map((revision) =>
    summarizeRevision({
      revision,
      revisions: history.revisions,
      currentContent,
      currentMd5: history.state?.md5 ?? null,
    }),
  );
}

export function getAgentTeamStructureRevision(
  revisionId: number,
  currentAgents: AgentConfig[],
): AgentTeamStructureRevision {
  const history = getRuntimeAssetRevisionDetailHistory(
    'team',
    AGENT_TEAM_STRUCTURE_ASSET_PATH,
    revisionId,
  );
  const revision = history.revision;
  if (!revision) {
    throw new Error(`Team structure revision ${revisionId} was not found.`);
  }
  const currentContent =
    history.state?.content ??
    serializeAgentTeamStructure(currentAgents, { validate: false });
  const nextContent =
    revision.replacedByMd5 && history.state?.md5 === revision.replacedByMd5
      ? currentContent
      : history.nextRevision?.content;
  const snapshot = parseAgentTeamStructureSnapshot(revision.content);
  const nextSnapshot = nextContent
    ? parseAgentTeamStructureSnapshot(nextContent)
    : null;
  const diff = diffAgentTeamStructureSnapshots(
    snapshot,
    nextSnapshot ?? snapshot,
  );
  const { content: _content, ...summary } = revision;
  return {
    ...summary,
    diff,
    changeCount: agentTeamStructureDiffCount(diff),
    snapshot,
  };
}
