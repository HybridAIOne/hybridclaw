export const DEFAULT_AGENT_ID = 'main';

export type AgentModelConfig =
  | string
  | {
      primary: string;
      fallbacks?: string[];
    };

export interface AgentCv {
  summary?: string;
  background?: string;
  capabilities?: string[];
  asset?: string;
}

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
  owner?: string;
  role?: string;
  cv?: AgentCv;
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

export function normalizeAgentCv(value: unknown): AgentCv | undefined {
  if (typeof value === 'string') {
    const asset = value.trim();
    return asset ? { asset } : undefined;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as {
    summary?: unknown;
    background?: unknown;
    capabilities?: unknown;
    asset?: unknown;
  };
  const summary = typeof raw.summary === 'string' ? raw.summary.trim() : '';
  const background =
    typeof raw.background === 'string' ? raw.background.trim() : '';
  const asset = typeof raw.asset === 'string' ? raw.asset.trim() : '';
  const capabilities = Array.isArray(raw.capabilities)
    ? Array.from(
        new Set(
          raw.capabilities
            .filter((entry): entry is string => typeof entry === 'string')
            .map((entry) => entry.trim())
            .filter(Boolean),
        ),
      )
    : [];
  const cv: AgentCv = {
    ...(summary ? { summary } : {}),
    ...(background ? { background } : {}),
    ...(capabilities.length > 0 ? { capabilities } : {}),
    ...(asset ? { asset } : {}),
  };
  return Object.keys(cv).length > 0 ? cv : undefined;
}

export function cloneAgentCv(value: AgentCv | undefined): AgentCv | undefined {
  if (!value) return undefined;
  const cv: AgentCv = {
    ...(value.summary ? { summary: value.summary } : {}),
    ...(value.background ? { background: value.background } : {}),
    ...(value.capabilities && value.capabilities.length > 0
      ? { capabilities: [...value.capabilities] }
      : {}),
    ...(value.asset ? { asset: value.asset } : {}),
  };
  return Object.keys(cv).length > 0 ? cv : undefined;
}

export function agentCvEquals(a?: AgentCv, b?: AgentCv): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.summary !== b.summary) return false;
  if (a.background !== b.background) return false;
  if (a.asset !== b.asset) return false;
  const aCaps = a.capabilities ?? [];
  const bCaps = b.capabilities ?? [];
  if (aCaps.length !== bCaps.length) return false;
  return aCaps.every((entry, index) => entry === bCaps[index]);
}
