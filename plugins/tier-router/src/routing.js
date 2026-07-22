export const TIER_ROUTING_METADATA_KEY = 'tierRouter';

function tierIndex(tiers, name) {
  return tiers.findIndex((tier) => tier.name === name);
}

function sourceMatches(source, expected) {
  return source === expected || source.startsWith(`${expected}.`);
}

export function classifyRoutingTurn(context) {
  const source = String(context.source || '');
  if (
    sourceMatches(source, 'heartbeat') ||
    context.channelType === 'heartbeat'
  ) {
    return 'heartbeat';
  }
  if (
    sourceMatches(source, 'scheduler') ||
    context.channelType === 'scheduler'
  ) {
    return 'scheduler';
  }
  if (sourceMatches(source, 'fullauto')) return 'fullauto';
  return 'agent';
}

export function findModelRoutingTier(tiers, model) {
  const normalized = String(model || '').trim();
  if (!normalized) return null;
  return tiers.find((tier) => tier.models.includes(normalized))?.name || null;
}

function normalizedTarget(config, context) {
  const target = {
    quality: Number(config.target?.quality ?? 0.5),
    speed: Number(config.target?.speed ?? 0.3),
    ...context.agentRouting?.target,
  };
  return {
    quality: Math.max(0, Math.min(1, target.quality)),
    speed: Math.max(0, Math.min(1, target.speed)),
  };
}

export function resolveTierRoutingDecision(config, context, manualEscalate) {
  if (
    !config?.enabled ||
    !Array.isArray(config.tiers) ||
    !config.tiers.length
  ) {
    return null;
  }
  if (context.explicitModelPinned) return null;

  const taxonomy = classifyRoutingTurn(context);
  const target = normalizedTarget(config, context);
  let startIndex = 0;
  let reason = `system-${taxonomy}`;
  if (taxonomy === 'agent') {
    const agentTier = findModelRoutingTier(config.tiers, context.agentModel);
    const targetTier =
      config.tiers[Math.round(target.quality * (config.tiers.length - 1))]
        ?.name;
    const configuredStart = context.agentRouting?.start;
    startIndex = Math.max(
      0,
      tierIndex(
        config.tiers,
        configuredStart || agentTier || targetTier || config.defaultStart,
      ),
    );
    reason = configuredStart
      ? 'agent-routing-start'
      : agentTier
        ? 'agent-model-start'
        : targetTier
          ? 'quality-target'
          : 'default-start';
    const minimumIndex = tierIndex(config.tiers, context.skillRouting?.minTier);
    if (minimumIndex > startIndex) {
      startIndex = minimumIndex;
      reason = 'skill-minimum-tier';
    }
    const stickyIndex = tierIndex(config.tiers, context.stickyTier);
    if (stickyIndex > startIndex) {
      startIndex = stickyIndex;
      reason = 'sticky-tier';
    }
    if (manualEscalate && startIndex < config.tiers.length - 1) {
      startIndex += 1;
      reason = 'manual-escalate';
    }
  }
  const tier = config.tiers[startIndex];
  if (!tier?.models?.length) return null;
  return {
    taxonomy,
    startTier: tier.name,
    model: tier.models[0],
    reason,
    target,
  };
}
