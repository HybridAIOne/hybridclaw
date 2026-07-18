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
  let startIndex = 0;
  let reason = `system-${taxonomy}`;
  if (taxonomy === 'agent') {
    const agentTier = findModelRoutingTier(config.tiers, context.agentModel);
    startIndex = Math.max(
      0,
      tierIndex(config.tiers, agentTier || config.defaultStart),
    );
    reason = agentTier ? 'agent-start' : 'default-start';
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
  };
}
