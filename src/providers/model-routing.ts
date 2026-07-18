export const MODEL_ROUTING_ZONES = ['local', 'hai', 'region', 'cloud'] as const;

export type ModelRoutingZone = (typeof MODEL_ROUTING_ZONES)[number];

export interface ModelRoutingTier {
  name: string;
  models: string[];
}

export interface ModelRoutingConfig {
  enabled: boolean;
  tiers: ModelRoutingTier[];
  defaultStart: string;
  escalationStickyTurns: number;
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
        models: tier.models.filter((model) =>
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
