const AGENT_ADDRESS_PATTERN =
  '[A-Za-z0-9._-]+(?:@[A-Za-z0-9._-]+@[A-Za-z0-9._-]+)?';
const MENTION_BOUNDARY = String.raw`(?=$|[\s:.,!?;)\]}])`;
const LEADING_AGENT_MENTION_RE = new RegExp(
  `^@(${AGENT_ADDRESS_PATTERN})${MENTION_BOUNDARY}`,
  'u',
);
const AGENT_MENTION_RE = new RegExp(
  `@(${AGENT_ADDRESS_PATTERN})${MENTION_BOUNDARY}`,
  'gu',
);

export interface LeadingAgentMention {
  mention: string;
  agentId: string;
  rest: string;
}

export interface AgentMentionMatch {
  mention: string;
  agentId: string;
  index: number;
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

export function findAgentMentions(content: string): AgentMentionMatch[] {
  const matches: AgentMentionMatch[] = [];
  for (const match of content.matchAll(AGENT_MENTION_RE)) {
    const mention = match[0];
    const agentId = match[1] ?? '';
    const index = match.index ?? 0;
    if (!agentId) continue;
    const previous = index === 0 ? '' : content[index - 1];
    if (previous && !/[\s([{]/u.test(previous)) continue;
    matches.push({ mention, agentId, index });
  }
  return matches;
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
