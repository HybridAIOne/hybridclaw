import { listAgents, peersOfAgent } from '../agents/agent-registry.js';
import { type AgentConfig, DEFAULT_AGENT_ID } from '../agents/agent-types.js';
import { getMemoryValue, setMemoryValue } from '../memory/db.js';
import type { Session } from '../types/session.js';
import type { GatewayAddressEnvelope } from './gateway-types.js';

const ACTIVE_AGENT_KEY_PREFIX = 'gateway.activeAgent:';
const HANDLE_RE = /(^|[\s([{])@([A-Za-z0-9][A-Za-z0-9._-]{0,127})\b/gu;
const SIMPLE_CONTEXT_REFERENCE_HANDLES = new Set(['diff', 'staged']);
const VALUED_CONTEXT_REFERENCE_HANDLES = new Set([
  'file',
  'folder',
  'git',
  'url',
]);

export type AgentAddressResolution =
  | { kind: 'none'; content: string; envelope?: undefined }
  | {
      kind: 'agent';
      agentId: string;
      handle: string;
      content: string;
      envelope: GatewayAddressEnvelope;
    }
  | {
      kind: 'fanout';
      alias: 'team' | 'all';
      agentIds: string[];
      handle: string;
      content: string;
      envelope: GatewayAddressEnvelope;
    }
  | { kind: 'error'; handle: string; message: string; content: string };

function slugify(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

function compact(value: string): string {
  return slugify(value).replace(/[^a-z0-9]/g, '');
}

function aliasesForAgent(agent: AgentConfig): Set<string> {
  const aliases = new Set<string>();
  for (const raw of [
    agent.id,
    agent.name,
    agent.displayName,
    agent.canonicalId?.split('@', 1)[0],
  ]) {
    if (!raw) continue;
    const slug = slugify(raw);
    if (slug) aliases.add(slug);
    const compactAlias = compact(raw);
    if (compactAlias) aliases.add(compactAlias);
  }
  return aliases;
}

function uniqueAgentIds(agents: readonly AgentConfig[]): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const agent of agents) {
    if (!agent.id || seen.has(agent.id)) continue;
    seen.add(agent.id);
    ids.push(agent.id);
  }
  return ids;
}

function resolveByOrgContext(
  matches: readonly AgentConfig[],
  currentAgentId: string,
): AgentConfig[] {
  if (matches.length <= 1) return [...matches];
  const matchIds = new Set(matches.map((agent) => agent.id));

  const peers = peersOfAgent(currentAgentId).filter((agent) =>
    matchIds.has(agent.id),
  );
  if (peers.length > 0) return peers;

  const currentAgent = listAgents().find(
    (agent) => agent.id === currentAgentId,
  );
  const delegateIds = new Set(currentAgent?.delegatesTo ?? []);
  const delegates = matches.filter((agent) => delegateIds.has(agent.id));
  if (delegates.length > 0) return delegates;

  return [...matches];
}

function stripLeadingHandle(content: string, match: RegExpExecArray): string {
  const before = content.slice(0, match.index);
  if (before.trim()) return content;
  let end = match.index + match[0].length;
  if (content[end] === ':') {
    end += 1;
  }
  return `${before}${content.slice(end)}`.trimStart();
}

function isLeadingHandle(content: string, match: RegExpExecArray): boolean {
  return content.slice(0, match.index).trim().length === 0;
}

function isContextReference(
  content: string,
  match: RegExpExecArray,
  normalizedHandle: string,
): boolean {
  const end = match.index + match[0].length;
  return (
    SIMPLE_CONTEXT_REFERENCE_HANDLES.has(normalizedHandle) ||
    (VALUED_CONTEXT_REFERENCE_HANDLES.has(normalizedHandle) &&
      content[end] === ':')
  );
}

export function resolveAgentAddressing(params: {
  content: string;
  currentAgentId?: string | null;
  fromAgentId?: string | null;
}): AgentAddressResolution {
  const content = params.content;
  const currentAgentId = params.currentAgentId?.trim() || DEFAULT_AGENT_ID;
  const fromAgentId = params.fromAgentId?.trim() || currentAgentId;
  const agents = listAgents();

  for (const match of content.matchAll(HANDLE_RE)) {
    const handle = match[2] ?? '';
    const normalizedHandle = slugify(handle);
    const compactHandle = compact(handle);
    if (isContextReference(content, match, normalizedHandle)) continue;

    const strippedContent = stripLeadingHandle(content, match);

    if (normalizedHandle === 'team' || normalizedHandle === 'all') {
      const agentIds = uniqueAgentIds(
        agents.filter(
          (agent) => normalizedHandle === 'all' || agent.id !== currentAgentId,
        ),
      );
      return {
        kind: 'fanout',
        alias: normalizedHandle,
        agentIds,
        handle,
        content: strippedContent,
        envelope: {
          to: agentIds,
          from: fromAgentId,
          fanoutAlias: normalizedHandle,
        },
      };
    }

    const matches = agents.filter((agent) => {
      const aliases = aliasesForAgent(agent);
      return aliases.has(normalizedHandle) || aliases.has(compactHandle);
    });

    if (matches.length === 0) {
      if (!isLeadingHandle(content, match)) continue;
      return {
        kind: 'error',
        handle,
        content,
        message: `Unknown agent address @${handle}. Use /agent list to see available agents.`,
      };
    }

    const resolved = resolveByOrgContext(matches, currentAgentId);
    if (resolved.length !== 1) {
      const options = resolved.map((agent) => agent.id).join(', ');
      return {
        kind: 'error',
        handle,
        content,
        message: `Ambiguous agent address @${handle}. Matching agents: ${options}. Use the exact agent id.`,
      };
    }

    const agentId = resolved[0]?.id ?? DEFAULT_AGENT_ID;
    return {
      kind: 'agent',
      agentId,
      handle,
      content: strippedContent,
      envelope: {
        to: agentId,
        from: fromAgentId,
      },
    };
  }

  return { kind: 'none', content };
}

function threadStateKey(
  session: Pick<Session, 'id' | 'session_key' | 'main_session_key'>,
): string {
  const stableKey =
    session.main_session_key || session.session_key || session.id;
  return `${ACTIVE_AGENT_KEY_PREFIX}${stableKey}`;
}

export function getActiveThreadAgentId(session: Session): string | null {
  const value = getMemoryValue(session.id, threadStateKey(session));
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function setActiveThreadAgentId(
  session: Session,
  agentId: string,
): void {
  const normalized = agentId.trim();
  if (!normalized) return;
  setMemoryValue(session.id, threadStateKey(session), normalized);
}
