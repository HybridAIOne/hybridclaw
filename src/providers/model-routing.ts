export const MODEL_ROUTING_ZONES = ['local', 'hai', 'region', 'cloud'] as const;

export type ModelRoutingZone = (typeof MODEL_ROUTING_ZONES)[number];

export interface ModelRoutingTier {
  name: string;
  models: string[];
}

export interface ModelRoutingTarget {
  quality: number;
  speed: number;
}

export interface ModelRoutingBudgetClampConfig {
  enabled: boolean;
}

export interface ModelRoutingConfig {
  enabled: boolean;
  tiers: ModelRoutingTier[];
  defaultStart: string;
  escalationStickyTurns: number;
  sovereignty?: ModelRoutingZone;
  target?: ModelRoutingTarget;
  sensitivityZones?: Record<string, ModelRoutingZone>;
  budgetClamp?: ModelRoutingBudgetClampConfig;
}

export interface ResolveLadderContext {
  startTier?: string;
  minimumTier?: string;
  maximumTier?: string;
  stickyTier?: string;
  maximumZone?: ModelRoutingZone;
  modelZones?: Readonly<Record<string, ModelRoutingZone | undefined>>;
  speedTarget?: number;
  modelLatenciesMs?: Readonly<Record<string, number | undefined>>;
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

export interface ModelRoutingTurnMetadata {
  enabled: true;
  startTier: string | null;
  finalTier: string | null;
  model: string | null;
  zone: ModelRoutingZone | null;
  reason: string;
  escalated: boolean;
  attempts: number;
  sovereignty: ModelRoutingZone;
  target: ModelRoutingTarget;
  actualCostUsd?: number;
  counterfactualCostUsd?: number;
  savedUsd?: number;
  exhausted?: boolean;
  approvalId?: string;
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

export function isModelRoutingZone(value: unknown): value is ModelRoutingZone {
  return (
    typeof value === 'string' &&
    MODEL_ROUTING_ZONES.includes(value.trim().toLowerCase() as ModelRoutingZone)
  );
}

export function mostRestrictiveModelRoutingZone(
  ...zones: Array<ModelRoutingZone | undefined>
): ModelRoutingZone {
  let mostRestrictive = MODEL_ROUTING_ZONES.length - 1;
  for (const zone of zones) {
    if (!zone) continue;
    mostRestrictive = Math.min(
      mostRestrictive,
      ZONE_INDEX.get(zone) ?? MODEL_ROUTING_ZONES.length - 1,
    );
  }
  return MODEL_ROUTING_ZONES[mostRestrictive] ?? 'cloud';
}

function clampTarget(value: number | undefined, fallback: number): number {
  return Math.max(0, Math.min(1, value ?? fallback));
}

export function normalizeModelRoutingTarget(
  target?: Partial<ModelRoutingTarget>,
  fallback: ModelRoutingTarget = { quality: 0.5, speed: 0.3 },
): ModelRoutingTarget {
  return {
    quality: clampTarget(target?.quality, fallback.quality),
    speed: clampTarget(target?.speed, fallback.speed),
  };
}

export function resolveTargetStartTier(
  tiers: ModelRoutingTier[],
  quality: number,
): string | undefined {
  if (tiers.length === 0) return undefined;
  const index = Math.round(clampTarget(quality, 0.5) * (tiers.length - 1));
  return tiers[index]?.name;
}

export function resolveWeakOutputRetries(quality: number): number {
  return clampTarget(quality, 0.5) >= 0.75 ? 0 : 1;
}

export function resolveBudgetMaximumTier(
  tiers: ModelRoutingTier[],
  usageRatio: number,
): string | undefined {
  if (tiers.length === 0) return undefined;
  const remainingRatio = 1 - Math.max(0, Math.min(1, usageRatio));
  const maximumIndex = Math.floor(remainingRatio * (tiers.length - 1));
  return tiers[maximumIndex]?.name;
}

export function resolveSensitivityMaximumZone(
  sensitivity: string | undefined,
  sensitivityZones: Readonly<Record<string, ModelRoutingZone>> | undefined,
): ModelRoutingZone | undefined {
  if (!sensitivity) return undefined;
  const normalized = sensitivity.trim().toLowerCase();
  if (!normalized) return undefined;
  return sensitivityZones?.[normalized] ?? 'local';
}

export function orderRoutingModelsByTarget(
  models: string[],
  speed: number,
  modelLatenciesMs: Readonly<Record<string, number | undefined>> | undefined,
): string[] {
  const normalizedSpeed = clampTarget(speed, 0.3);
  if (normalizedSpeed === 0 || models.length < 2 || !modelLatenciesMs) {
    return [...models];
  }
  const measured = models
    .map((model) => modelLatenciesMs[model])
    .filter(
      (latency): latency is number =>
        typeof latency === 'number' && Number.isFinite(latency) && latency >= 0,
    );
  if (measured.length < 2) return [...models];

  const minimumLatency = Math.min(...measured);
  const maximumLatency = Math.max(...measured);
  const latencyRange = maximumLatency - minimumLatency;
  const lastIndex = models.length - 1;
  return models
    .map((model, index) => {
      const latency = modelLatenciesMs[model];
      const positionScore = index / lastIndex;
      const latencyScore =
        typeof latency === 'number' && Number.isFinite(latency) && latency >= 0
          ? latencyRange === 0
            ? 0
            : (latency - minimumLatency) / latencyRange
          : 1;
      return {
        model,
        index,
        score:
          (1 - normalizedSpeed) * positionScore +
          normalizedSpeed * latencyScore,
      };
    })
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map((entry) => entry.model);
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
        models: orderRoutingModelsByTarget(
          tier.models.filter((model) =>
            modelRoutingZoneAllows(maximumZone, context.modelZones?.[model]),
          ),
          context.speedTarget ?? config.target?.speed ?? 0.3,
          context.modelLatenciesMs,
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
