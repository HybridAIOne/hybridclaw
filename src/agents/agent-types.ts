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
  model?: AgentModelConfig;
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
  defaults?: AgentDefaultsConfig;
  list?: AgentConfig[];
}
