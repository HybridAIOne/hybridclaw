/**
 * Resolve schema visibility from instance defaults and an agent's config override.
 * Unlike tool-policy.ts this grants no permission; runners pass the selected
 * names alongside the separately restricted tool catalog.
 */
import { DEFAULT_LOCAL_STARTER_TOOLS } from '../../container/shared/local-tool-config.js';
import { DEFAULT_AGENT_ID } from '../agents/agent-types.js';
import { getRuntimeConfig } from '../config/runtime-config.js';

export function resolveLocalStarterTools(agentId?: string): string[] {
  const config = getRuntimeConfig();
  const id = agentId?.trim() || DEFAULT_AGENT_ID;
  const agent = config.agents.list?.find((entry) => entry.id === id);
  return [
    ...(agent?.localStarterTools ??
      config.tools.localStarterTools ??
      DEFAULT_LOCAL_STARTER_TOOLS),
  ];
}

export function resolveLocalToolMode(agentId?: string): 'full' | 'starred' {
  const config = getRuntimeConfig();
  const id = agentId?.trim() || DEFAULT_AGENT_ID;
  return (
    config.agents.list?.find((entry) => entry.id === id)?.localToolMode ??
    config.tools.localToolMode ??
    'starred'
  );
}
