/**
 * One policy selects from the operator's tier ladder after privacy and capability gates.
 * Classifiers supply evidence, never model IDs. Tier order is the speed proxy;
 * this is not a measured latency predictor or a billing calculation.
 */
import type { RuntimeRoutingConfig } from '../config/runtime-config.js';
import {
  type ModelRoutingZone,
  resolveLadder,
} from '../providers/model-routing.js';

export interface RoutingSignals {
  capability: 'basic' | 'standard' | 'advanced' | 'uncertain';
  urgency: 'urgent' | 'normal' | 'relaxed' | 'unspecified';
  sensitive: boolean;
}
export const UNKNOWN_SIGNALS: RoutingSignals = {
  capability: 'uncertain',
  urgency: 'unspecified',
  sensitive: false,
};
export interface RoutingModelMetadata {
  zone: ModelRoutingZone;
  pricingUsdPerToken: { input: number | null; output: number | null };
}
export function selectRoutingPolicy(input: {
  config: RuntimeRoutingConfig;
  signals: RoutingSignals;
  localOnly: boolean;
  minimumTier?: string;
  metadata: (model: string) => RoutingModelMetadata;
}) {
  const { config, signals, metadata } = input;
  if (!config.tiers.length)
    return {
      ladder: {
        enabled: config.enabled,
        tiers: [],
        startTier: null,
        startIndex: -1,
        referenceModel: null,
        reason: 'no-eligible-models' as const,
        exhausted: true,
      },
      preference: config.preference,
      privateRoute:
        input.localOnly || signals.sensitive || config.mode === 'privacy',
      reason: 'no-eligible-models',
    };
  const privateRoute =
    input.localOnly || signals.sensitive || config.mode === 'privacy';
  const zones = Object.fromEntries(
    config.tiers.flatMap((tier) =>
      tier.models.map((model) => [model, metadata(model).zone]),
    ),
  );
  const defaultIndex = Math.max(
    0,
    config.tiers.findIndex((tier) => tier.name === config.defaultStart),
  );
  // Owner policy (2026-09-21): ordered tiers represent increasing capability.
  // Latency measurements and calibrated per-model quality scores are deferred.
  const capabilityIndex =
    signals.capability === 'basic'
      ? 0
      : signals.capability === 'standard'
        ? Math.ceil((config.tiers.length - 1) / 2)
        : signals.capability === 'advanced'
          ? config.tiers.length - 1
          : defaultIndex;
  const floor = Math.max(
    capabilityIndex,
    config.tiers.findIndex((tier) => tier.name === input.minimumTier),
  );
  const preference =
    signals.urgency === 'urgent'
      ? 'asap'
      : signals.urgency === 'normal'
        ? 'balanced'
        : signals.urgency === 'relaxed'
          ? 'no_hurry'
          : config.preference;
  const candidates = config.tiers.flatMap((tier, index) =>
    index < floor
      ? []
      : tier.models.flatMap((model, order) => {
          const info = metadata(model);
          if (privateRoute && info.zone !== 'local') return [];
          const price = info.pricingUsdPerToken;
          return [
            {
              index,
              order,
              model,
              cost:
                price.input !== null && price.output !== null
                  ? price.input + price.output
                  : null,
            },
          ];
        }),
  );
  let selected = candidates[0];
  const priced = candidates.filter((candidate) => candidate.cost !== null);
  const cheapest = [...priced].sort(
    (a, b) => a.cost! - b.cost! || a.index - b.index || a.order - b.order,
  )[0];
  if (
    config.mode === 'cost' ||
    (config.mode === 'auto' && preference === 'no_hurry')
  )
    selected = cheapest ?? selected;
  else if (
    config.mode === 'auto' &&
    preference === 'balanced' &&
    priced.length
  ) {
    // Pareto filter on configured speed rank and known token price; unknown is not free.
    const frontier = priced.filter(
      (candidate) =>
        !priced.some(
          (other) =>
            other.index <= candidate.index &&
            other.cost! <= candidate.cost! &&
            (other.index < candidate.index || other.cost! < candidate.cost!),
        ),
    );
    const minCost = Math.min(...frontier.map((c) => c.cost!));
    const maxCost = Math.max(...frontier.map((c) => c.cost!));
    const score = (candidate: (typeof frontier)[number]) =>
      (candidate.index - floor) / Math.max(1, config.tiers.length - 1 - floor) +
      (candidate.cost! - minCost) / (maxCost - minCost || 1);
    selected = [...frontier].sort(
      (a, b) => score(a) - score(b) || a.index - b.index,
    )[0];
  }
  const startTier = selected
    ? config.tiers[selected.index].name
    : config.tiers[Math.max(0, floor)]?.name;
  const ladder = resolveLadder(config, {
    startTier,
    maximumZone: privateRoute ? 'local' : 'cloud',
    modelZones: zones,
  });
  if (selected && !ladder.exhausted) {
    const first = ladder.tiers[ladder.startIndex];
    first.models = [
      selected.model,
      ...first.models.filter((model) => model !== selected.model),
    ];
  }
  return {
    ladder,
    preference,
    privateRoute,
    reason: `${config.mode} · ${signals.capability} · ${preference}${privateRoute ? ' · local only' : ''}${config.mode === 'cost' && !cheapest ? ' · price unavailable' : ''}`,
  };
}
