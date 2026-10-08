/**
 * What the console calls an agent: its own name, else the display name the
 * installer gave it (HybridAI sets only that for the agents it creates), else
 * its id.
 */
export function agentLabel(agent: {
  id: string;
  name?: string | null;
  displayName?: string | null;
}): string {
  return agent.name || agent.displayName || agent.id;
}
