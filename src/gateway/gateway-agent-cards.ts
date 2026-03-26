import path from 'node:path';

import {
  resolveAgentConfig,
  resolveAgentForRequest,
  resolveAgentModel,
} from '../agents/agent-registry.js';
import type { AgentConfig } from '../agents/agent-types.js';
import { getDiscordChannelDisplayName } from '../channels/discord/runtime.js';
import { agentWorkspaceDir } from '../infra/ipc.js';
import {
  getRecentMessages,
  getRecentStructuredAuditForSession,
} from '../memory/db.js';
import { parseSessionKey } from '../session/session-key.js';
import type { StructuredAuditEntry } from '../types/audit.js';
import type { Session, StoredMessage } from '../types/session.js';
import { isFullAutoEnabled } from './fullauto.js';
import { formatRelativeTimeFromMs, parseTimestamp } from './gateway-time.js';
import type {
  GatewayLogicalAgentCard,
  GatewaySessionCard,
} from './gateway-types.js';
import { numberFromUnknown, parseAuditPayload } from './gateway-utils.js';

export interface GatewaySessionUsageSummary {
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost_usd: number;
  total_tool_calls: number;
}

function trimPreviewText(raw: string, maxLength = 160): string {
  const compact = String(raw || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!compact) return '';
  return compact.length > maxLength
    ? `${compact.slice(0, maxLength - 3).trimEnd()}...`
    : compact;
}

function buildAgentName(session: Session): string {
  const parsedKey = parseSessionKey(session.id);
  if (parsedKey?.channelKind === 'heartbeat') {
    return `Heartbeat ${parsedKey.agentId}`;
  }
  if (parsedKey?.channelKind === 'scheduler') {
    return `Scheduler ${parsedKey.peerId}`;
  }
  // Keep pre-hierarchical prefixes for rows created before v11 migration or
  // restored from older exports.
  if (session.id.startsWith('heartbeat:')) {
    return `Heartbeat ${session.id.slice('heartbeat:'.length)}`;
  }
  if (session.id.startsWith('scheduler:')) {
    return `Scheduler ${session.id.slice('scheduler:'.length)}`;
  }
  if (session.id.startsWith('delegate:')) {
    return 'Delegated task';
  }
  if (session.id.startsWith('web:')) {
    return `Web ${session.channel_id}`;
  }
  if (session.id.startsWith('tui:')) {
    return `TUI ${session.channel_id}`;
  }
  return session.id;
}

function buildAgentTask(session: Session, messages: StoredMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (String(message.role || '').toLowerCase() !== 'user') continue;
    const preview = trimPreviewText(message.content, 180);
    if (preview) return preview;
  }
  if (session.session_summary) {
    const preview = trimPreviewText(session.session_summary, 180);
    if (preview) return preview;
  }
  const parsedKey = parseSessionKey(session.id);
  if (parsedKey?.channelKind === 'heartbeat') {
    return 'Periodic heartbeat session using the configured runtime workspace.';
  }
  if (parsedKey?.channelKind === 'scheduler') {
    return 'Config-backed scheduler job delivering an automated agent turn.';
  }
  // Keep pre-hierarchical prefixes for rows created before v11 migration or
  // restored from older exports.
  if (session.id.startsWith('heartbeat:')) {
    return 'Periodic heartbeat session using the configured runtime workspace.';
  }
  if (session.id.startsWith('scheduler:')) {
    return 'Config-backed scheduler job delivering an automated agent turn.';
  }
  if (session.id.startsWith('delegate:')) {
    return 'Delegated sub-agent session spawned for a focused task.';
  }
  return 'Persisted runtime session with no recent user prompt available.';
}

function buildAgentConversationPreview(messages: StoredMessage[]): {
  lastQuestion: string | null;
  lastAnswer: string | null;
} {
  let pendingAnswer: string | null = null;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const role = String(message.role || '').toLowerCase();
    const preview = trimPreviewText(message.content, 140);
    if (!preview) continue;

    if (role === 'assistant') {
      if (!pendingAnswer) {
        pendingAnswer = preview;
      }
      continue;
    }

    if (role === 'user') {
      return {
        lastQuestion: preview,
        lastAnswer: pendingAnswer,
      };
    }
  }

  return {
    lastQuestion: null,
    lastAnswer: pendingAnswer,
  };
}

function summarizeAgentAuditPreview(row: StructuredAuditEntry): string {
  const payload = parseAuditPayload(row);
  const eventType = String(row.event_type || '').trim() || 'event';
  const payloadType =
    typeof payload?.type === 'string' ? payload.type.trim() : eventType;

  if (payloadType === 'tool.result') {
    const toolName = String(payload?.toolName || 'tool').trim() || 'tool';
    const status = payload?.isError === true ? 'error' : 'ok';
    const durationMs = numberFromUnknown(payload?.durationMs);
    return `${toolName} ${status}${durationMs == null ? '' : ` ${durationMs}ms`}`;
  }

  if (payloadType === 'tool.call') {
    const toolName = String(payload?.toolName || 'tool').trim() || 'tool';
    return `${toolName} called`;
  }

  if (payloadType === 'turn.end') {
    const finishReason =
      typeof payload?.finishReason === 'string' && payload.finishReason.trim()
        ? payload.finishReason.trim()
        : 'completed';
    return finishReason === 'completed'
      ? 'turn completed'
      : `turn ${finishReason}`;
  }

  if (payloadType === 'turn.start') {
    return 'turn started';
  }

  if (payloadType === 'session.start') {
    return 'session started';
  }

  if (payloadType === 'session.end') {
    const reason =
      typeof payload?.reason === 'string' && payload.reason.trim()
        ? payload.reason.trim()
        : 'completed';
    return reason === 'normal' ? 'session completed' : `session ${reason}`;
  }

  if (payloadType === 'model.usage') {
    const model = String(payload?.model || '').trim();
    const provider = String(payload?.provider || '').trim();
    const label = [provider, model].filter(Boolean).join(' ');
    return label ? `${label} usage` : 'model usage recorded';
  }

  if (payloadType === 'authorization.check') {
    const action = String(payload?.action || '')
      .replace(/^tool:/, '')
      .trim();
    const allowed = payload?.allowed === true;
    if (action) {
      return `${action} ${allowed ? 'allowed' : 'blocked'}`;
    }
    return allowed ? 'authorization allowed' : 'authorization blocked';
  }

  if (payloadType === 'approval.request') {
    return 'approval requested';
  }

  if (payloadType === 'approval.response') {
    if (payload?.approved === true) return 'approval granted';
    return 'approval denied';
  }

  if (payloadType === 'context.optimization') {
    return 'context optimized';
  }

  if (payloadType === 'error') {
    const message =
      typeof payload?.message === 'string' && payload.message.trim()
        ? payload.message.trim()
        : '';
    return trimPreviewText(message ? `error · ${message}` : 'error', 120);
  }

  return trimPreviewText(eventType.replace(/\./g, ' '), 120);
}

function buildAgentPreview(
  session: Session,
  messages: StoredMessage[],
): {
  title: string;
  meta: string | null;
  lines: string[];
} {
  const auditRows = getRecentStructuredAuditForSession(session.id, 6);
  const messageRows = messages.slice(-4);

  const activity = [
    ...auditRows.map((row) => {
      const timestampMs = parseTimestamp(row.timestamp)?.getTime() ?? 0;
      return {
        timestampMs,
        kind: 'audit' as const,
        label: row.event_type,
        line: trimPreviewText(
          `${formatRelativeTimeFromMs(timestampMs)} · ${summarizeAgentAuditPreview(row)}`,
          180,
        ),
      };
    }),
    ...messageRows.map((message) => {
      const role = String(message.role || '').toLowerCase();
      const label = role === 'assistant' ? 'assistant' : 'user';
      const timestampMs = parseTimestamp(message.created_at)?.getTime() ?? 0;
      return {
        timestampMs,
        kind: 'chat' as const,
        label,
        line: trimPreviewText(
          `${formatRelativeTimeFromMs(timestampMs)} · ${label} · ${String(message.content || '')}`,
          180,
        ),
      };
    }),
  ]
    .filter((entry) => entry.line)
    .sort((left, right) => right.timestampMs - left.timestampMs)
    .slice(0, 6);

  if (activity.length === 0) {
    return {
      title: 'No recent activity',
      meta: 'Persisted session',
      lines: [
        'No recent audit or chat activity captured for this session yet.',
      ],
    };
  }

  const uniqueAuditTypes = Array.from(
    new Set(
      activity
        .filter((entry) => entry.kind === 'audit')
        .map((entry) => entry.label),
    ),
  );
  const chatCount = activity.filter((entry) => entry.kind === 'chat').length;
  const mostRecent = activity[0];

  let title = 'Recent activity';
  if (uniqueAuditTypes.length > 0 && chatCount > 0) {
    title =
      uniqueAuditTypes.length === 1
        ? `${uniqueAuditTypes[0]} + chat`
        : `${uniqueAuditTypes[0]} + ${uniqueAuditTypes[1] || 'chat'}`;
  } else if (uniqueAuditTypes.length > 0) {
    title =
      uniqueAuditTypes.length === 1
        ? uniqueAuditTypes[0]
        : `${uniqueAuditTypes[0]} + ${uniqueAuditTypes[1]}`;
  } else if (chatCount > 0) {
    title = 'Chat transcript';
  }

  return {
    title,
    meta: `${activity.length} items · ${formatRelativeTimeFromMs(mostRecent.timestampMs)}`,
    lines: activity.map((entry) => entry.line),
  };
}

function getSessionStatus(
  session: Session,
  activeSessionIds: Set<string>,
  lastActiveMs: number,
): GatewaySessionCard['status'] {
  if (activeSessionIds.has(session.id)) return 'active';
  if (lastActiveMs > 0 && Date.now() - lastActiveMs <= 60 * 60 * 1000) {
    return 'idle';
  }
  return 'stopped';
}

function getAgentWatcherLabel(
  status: GatewaySessionCard['status'],
  sandboxMode: string,
): string {
  if (status === 'active') return `${sandboxMode} runtime attached`;
  if (status === 'idle') return `runtime idle (${sandboxMode})`;
  return 'runtime detached';
}

export function mapSessionCard(params: {
  session: Session;
  activeSessionIds: Set<string>;
  usageBySession: Map<string, GatewaySessionUsageSummary>;
  sandboxMode: string;
}): GatewaySessionCard {
  const { session, activeSessionIds, usageBySession, sandboxMode } = params;
  const { agentId, model: effectiveModel } = resolveAgentForRequest({
    session,
  });
  const startedAtMs =
    parseTimestamp(session.created_at)?.getTime() ?? Date.now();
  const lastActiveMs = parseTimestamp(session.last_active)?.getTime() ?? 0;
  const status = getSessionStatus(session, activeSessionIds, lastActiveMs);
  const usage = usageBySession.get(session.id);
  const startedAt = session.created_at;
  const endMs = status === 'stopped' ? lastActiveMs || Date.now() : Date.now();
  const runtimeMinutes = Math.max(
    0,
    Math.floor((endMs - Math.min(startedAtMs, endMs)) / 60_000),
  );
  const messages = getRecentMessages(session.id, 12);
  const preview = buildAgentPreview(session, messages);
  const conversation = buildAgentConversationPreview(messages);

  return {
    id: session.id,
    name: buildAgentName(session),
    task: buildAgentTask(session, messages),
    lastQuestion: conversation.lastQuestion,
    lastAnswer: conversation.lastAnswer,
    fullAutoEnabled: isFullAutoEnabled(session),
    model: effectiveModel,
    sessionId: session.id,
    channelId: session.channel_id,
    channelName: getDiscordChannelDisplayName(
      session.guild_id,
      session.channel_id,
    ),
    agentId,
    startedAt,
    lastActive: session.last_active,
    runtimeMinutes,
    inputTokens: usage?.total_input_tokens || 0,
    outputTokens: usage?.total_output_tokens || 0,
    costUsd: usage?.total_cost_usd || 0,
    messageCount: session.message_count,
    toolCalls: usage?.total_tool_calls || 0,
    status,
    watcher: getAgentWatcherLabel(status, sandboxMode),
    previewTitle: preview.title,
    previewMeta: preview.meta,
    output: preview.lines,
  };
}

function getLogicalAgentStatus(
  sessions: GatewaySessionCard[],
): GatewayLogicalAgentCard['status'] {
  if (sessions.length === 0) return 'unused';
  if (sessions.some((session) => session.status === 'active')) return 'active';
  if (sessions.some((session) => session.status === 'idle')) return 'idle';
  return 'stopped';
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const rawValue of values) {
    const value = String(rawValue || '').trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    deduped.push(value);
  }
  return deduped;
}

export function mapLogicalAgentCard(params: {
  agent: AgentConfig;
  sessions: GatewaySessionCard[];
  usage?: GatewaySessionUsageSummary;
}): GatewayLogicalAgentCard {
  const resolved = resolveAgentConfig(params.agent.id);
  const sessions = [...params.sessions].sort((left, right) => {
    const leftMs = parseTimestamp(left.lastActive)?.getTime() ?? 0;
    const rightMs = parseTimestamp(right.lastActive)?.getTime() ?? 0;
    return rightMs - leftMs;
  });
  const status = getLogicalAgentStatus(sessions);
  const usage = params.usage;

  return {
    id: resolved.id,
    name: resolved.name || null,
    model: resolveAgentModel(resolved) || null,
    chatbotId: resolved.chatbotId || null,
    enableRag:
      typeof resolved.enableRag === 'boolean' ? resolved.enableRag : null,
    workspace: resolved.workspace || null,
    workspacePath: path.resolve(agentWorkspaceDir(resolved.id)),
    sessionCount: sessions.length,
    activeSessions: sessions.filter((session) => session.status === 'active')
      .length,
    idleSessions: sessions.filter((session) => session.status === 'idle')
      .length,
    stoppedSessions: sessions.filter((session) => session.status === 'stopped')
      .length,
    effectiveModels: dedupeStrings(sessions.map((session) => session.model)),
    lastActive: sessions[0]?.lastActive || null,
    inputTokens: usage?.total_input_tokens || 0,
    outputTokens: usage?.total_output_tokens || 0,
    costUsd: usage?.total_cost_usd || 0,
    messageCount: sessions.reduce(
      (sum, session) => sum + Number(session.messageCount || 0),
      0,
    ),
    toolCalls: usage?.total_tool_calls || 0,
    recentSessionId: sessions[0]?.sessionId || null,
    status,
  };
}
