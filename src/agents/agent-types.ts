export const DEFAULT_AGENT_ID = 'main';

export type AgentModelConfig =
  | string
  | {
      primary: string;
      fallbacks?: string[];
    };

export interface AgentConfig {
  id: string;
  name?: string;
  displayName?: string;
  imageAsset?: string;
  model?: AgentModelConfig;
  skills?: string[];
  workspace?: string;
  chatbotId?: string;
  enableRag?: boolean;
}

export interface AgentDefaultsConfig {
  model?: AgentModelConfig;
  chatbotId?: string;
  enableRag?: boolean;
}

export interface AgentsConfig {
  defaultAgentId?: string;
  defaults?: AgentDefaultsConfig;
  list?: AgentConfig[];
}

export function buildOptionalAgentPresentation(
  displayName?: string | null,
  imageAsset?: string | null,
): Pick<AgentConfig, 'displayName' | 'imageAsset'> {
  return {
    ...(displayName ? { displayName } : {}),
    ...(imageAsset ? { imageAsset } : {}),
  };
}
