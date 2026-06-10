const LEADING_AGENT_MENTION_RE = /^@([A-Za-z0-9._-]+)(?=$|[\s:])/u;

export interface LeadingAgentMention {
  mention: string;
  agentId: string;
  rest: string;
}

export function parseLeadingAgentMention(
  content: string,
): LeadingAgentMention | null {
  const match = LEADING_AGENT_MENTION_RE.exec(content);
  if (!match) return null;
  const mention = match[0];
  const agentId = match[1] ?? '';
  if (!agentId) return null;
  return {
    mention,
    agentId,
    rest: content.slice(mention.length),
  };
}

export function normalizeAgentAttributionTarget(
  agentId: string | null | undefined,
): string | null {
  const trimmed = String(agentId ?? '').trim();
  if (!trimmed || trimmed.toLowerCase() === 'main') return null;
  return trimmed;
}

export function addAgentAttribution(
  content: string,
  agentId: string | null | undefined,
): string {
  const target = normalizeAgentAttributionTarget(agentId);
  if (!target || parseLeadingAgentMention(content)) return content;
  const trimmed = content.trimStart();
  return trimmed ? `@${target} ${trimmed}` : `@${target}`;
}
