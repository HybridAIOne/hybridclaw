import { buildSessionKey } from '../session/session-key.js';

export const DEFAULT_AGENT_COLLABORATION_DESTINATION = 'default';
const MAX_AGENT_COLLABORATION_DESTINATION_LENGTH = 64;

function normalizeAgentCollaborationString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function parseAgentCollaborationDestination(value: unknown): string {
  const normalized = normalizeAgentCollaborationString(value);
  if (!normalized) return DEFAULT_AGENT_COLLABORATION_DESTINATION;
  if (normalized.length > MAX_AGENT_COLLABORATION_DESTINATION_LENGTH) {
    throw new Error(
      `Agent collaboration destination must be ${MAX_AGENT_COLLABORATION_DESTINATION_LENGTH} characters or fewer.`,
    );
  }
  return normalized;
}

export function buildAgentCollaborationSessionKey(params: {
  sourceAgentId: string;
  targetAgentId: string;
  destination: string;
  sessionId?: string | null;
}): string {
  const explicitSessionId = normalizeAgentCollaborationString(params.sessionId);
  if (explicitSessionId) return explicitSessionId;
  return buildSessionKey(
    params.targetAgentId,
    'agent',
    'dm',
    params.sourceAgentId,
    {
      subagentId: params.destination,
    },
  );
}

function sanitizeChannelSegment(value: string): string {
  const normalized = normalizeAgentCollaborationString(value)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || DEFAULT_AGENT_COLLABORATION_DESTINATION;
}

export function buildAgentCollaborationChannelId(params: {
  sourceAgentId: string;
  destination: string;
}): string {
  return `agent:${sanitizeChannelSegment(params.sourceAgentId)}:${sanitizeChannelSegment(params.destination)}`;
}

export function formatAgentCollaborationPrompt(params: {
  sourceAgentId: string;
  targetAgentId: string;
  destination: string;
  text: string;
}): string {
  return [
    '# Agent Handoff',
    `- Source agent: \`${params.sourceAgentId}\``,
    `- Target agent: \`${params.targetAgentId}\``,
    `- Destination: \`${params.destination}\``,
    '- This is an internal agent-to-agent collaboration request, not a direct user message.',
    '- Reply to the requesting agent with the concrete result it needs.',
    '',
    '## Request',
    params.text.trim(),
  ].join('\n');
}
