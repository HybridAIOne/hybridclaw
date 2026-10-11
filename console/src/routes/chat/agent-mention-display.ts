import { AGENT_ADDRESS_PATTERN } from './agent-address-pattern';

const MENTION_BOUNDARY = String.raw`(?=$|[\s:.,!?;)\]}])`;
const AGENT_MENTION_RE = new RegExp(
  `@(${AGENT_ADDRESS_PATTERN})${MENTION_BOUNDARY}`,
  'gu',
);

export interface AgentMentionMatch {
  mention: string;
  agentId: string;
  index: number;
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
