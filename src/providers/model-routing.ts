/**
 * Capability tiers share names while modes own their model assignments.
 * Ladder resolution enforces ordering and zone boundaries, not classifier decisions.
 */
// Operator decision (2026-09-22): jurisdiction and hosting are separate privacy levels.
// Region denotes EU hosting; cloud denotes World, including unknown locations.
export const MODEL_ROUTING_ZONES = [
  'local',
  'hai',
  'eu-provider',
  'region',
  'cloud',
] as const;

export type ModelRoutingZone = (typeof MODEL_ROUTING_ZONES)[number];

export type RoutingMode = 'auto' | 'privacy' | 'speed' | 'cost';

export interface ModelRoutingTier {
  name: string;
  models: string[];
  modelsByMode?: Partial<Record<RoutingMode, string[]>>;
}

export interface ModelRoutingConfig {
  enabled: boolean;
  mode?: RoutingMode;
  tiers: ModelRoutingTier[];
  defaultStart: string;
  escalationStickyTurns: number;
}

export function routingTierModels(
  tier: ModelRoutingTier,
  mode: RoutingMode = 'auto',
): string[] {
  return tier.modelsByMode?.[mode] ?? tier.models;
}

export interface ResolveLadderContext {
  startTier?: string;
  minimumTier?: string;
  maximumTier?: string;
  stickyTier?: string;
  maximumZone?: ModelRoutingZone;
  modelZones?: Readonly<Record<string, ModelRoutingZone | undefined>>;
}

export type LadderResolutionReason =
  | 'disabled'
  | 'default-start'
  | 'configured-start'
  | 'minimum-tier'
  | 'sticky-tier'
  | 'no-eligible-models';

export interface ResolvedModelRoutingTier extends ModelRoutingTier {
  sourceIndex: number;
}

export interface ResolvedLadder {
  enabled: boolean;
  tiers: ResolvedModelRoutingTier[];
  startTier: string | null;
  startIndex: number;
  referenceModel: string | null;
  reason: LadderResolutionReason;
  exhausted: boolean;
}

const ZONE_INDEX = new Map<ModelRoutingZone, number>(
  MODEL_ROUTING_ZONES.map((zone, index) => [zone, index]),
);

export function normalizeModelRoutingZone(value: unknown): ModelRoutingZone {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  return MODEL_ROUTING_ZONES.includes(normalized as ModelRoutingZone)
    ? (normalized as ModelRoutingZone)
    : 'cloud';
}

/** Deployment classification applies to the transport route, not model authorship. */
export function configuredRemoteRoutingZone(
  model: string,
): ModelRoutingZone | null {
  const id = model.trim().toLowerCase();
  // Operator decision (2026-09-22): OpenAI/Anthropic through HybridAI use EU hosting.
  // Direct services remain World; this does not certify a provider's residency claims.
  if (/^(openrouter|anthropic|openai|openai-codex|codex|xai)\//.test(id))
    return 'cloud';
  const hybrid = id.startsWith('hybridai/')
    ? id.slice('hybridai/'.length)
    : !id.includes('/')
      ? id
      : '';
  if (/^(openai\/|anthropic\/|gpt-|claude-|o[134](?:-|$))/.test(hybrid))
    return 'region';
  return null;
}

export function modelRoutingZoneAllows(
  maximumZone: ModelRoutingZone,
  modelZone: ModelRoutingZone | undefined,
): boolean {
  return (
    (ZONE_INDEX.get(normalizeModelRoutingZone(modelZone)) ??
      MODEL_ROUTING_ZONES.length - 1) <=
    (ZONE_INDEX.get(maximumZone) ?? MODEL_ROUTING_ZONES.length - 1)
  );
}

function requireTierIndex(
  tiers: ModelRoutingTier[],
  tierName: string,
  field: string,
): number {
  const index = tiers.findIndex((tier) => tier.name === tierName);
  if (index < 0) {
    throw new Error(
      `${field} references unknown routing tier \`${tierName}\`.`,
    );
  }
  return index;
}

export function resolveLadder(
  config: ModelRoutingConfig,
  context: ResolveLadderContext = {},
): ResolvedLadder {
  if (!config.enabled) {
    return {
      enabled: false,
      tiers: [],
      startTier: null,
      startIndex: -1,
      referenceModel: null,
      reason: 'disabled',
      exhausted: false,
    };
  }

  if (config.tiers.length === 0) {
    throw new Error('Enabled model routing requires at least one tier.');
  }

  let desiredIndex = requireTierIndex(
    config.tiers,
    context.startTier ?? config.defaultStart,
    context.startTier ? 'startTier' : 'defaultStart',
  );
  let reason: LadderResolutionReason = context.startTier
    ? 'configured-start'
    : 'default-start';

  if (context.minimumTier) {
    const minimumIndex = requireTierIndex(
      config.tiers,
      context.minimumTier,
      'minimumTier',
    );
    if (minimumIndex > desiredIndex) {
      desiredIndex = minimumIndex;
      reason = 'minimum-tier';
    }
  }

  if (context.stickyTier) {
    const stickyIndex = requireTierIndex(
      config.tiers,
      context.stickyTier,
      'stickyTier',
    );
    if (stickyIndex > desiredIndex) {
      desiredIndex = stickyIndex;
      reason = 'sticky-tier';
    }
  }

  const maximumIndex = context.maximumTier
    ? requireTierIndex(config.tiers, context.maximumTier, 'maximumTier')
    : config.tiers.length - 1;
  const maximumZone = context.maximumZone ?? 'cloud';
  const tiers = config.tiers
    .map(
      (tier, sourceIndex): ResolvedModelRoutingTier => ({
        name: tier.name,
        models: routingTierModels(tier, config.mode).filter((model) =>
          modelRoutingZoneAllows(maximumZone, context.modelZones?.[model]),
        ),
        sourceIndex,
      }),
    )
    .filter(
      (tier) => tier.sourceIndex <= maximumIndex && tier.models.length > 0,
    );

  const startIndex = tiers.findIndex(
    (tier) => tier.sourceIndex >= desiredIndex,
  );
  if (desiredIndex > maximumIndex || startIndex < 0) {
    return {
      enabled: true,
      tiers,
      startTier: null,
      startIndex: -1,
      referenceModel: tiers.at(-1)?.models[0] ?? null,
      reason: 'no-eligible-models',
      exhausted: true,
    };
  }

  return {
    enabled: true,
    tiers,
    startTier: tiers[startIndex]?.name ?? null,
    startIndex,
    referenceModel: tiers.at(-1)?.models[0] ?? null,
    reason,
    exhausted: false,
  };
}
