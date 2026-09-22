import { describe, expect, test } from 'vitest';
import { DEFAULT_RUNTIME_CONFIG } from '../src/config/runtime-config.js';
import { selectRoutingPolicy, UNKNOWN_SIGNALS } from '../src/routing/policy.js';
const config = { ...DEFAULT_RUNTIME_CONFIG.routing, enabled: true, tiers: [{ name: 'small', models: ['cloud-fast', 'local-small'] }, { name: 'medium', models: ['cloud-cheap','local-mid'] }, { name: 'large', models: ['cloud-large','local-large'] }], defaultStart: 'small' };
const metadata = (model: string) => ({ zone: model.startsWith('local') ? 'local' as const : 'cloud' as const, pricingUsdPerToken: { input: model === 'cloud-cheap' ? 1 : 3, output: model === 'cloud-cheap' ? 1 : 3 } });
const route = (changes = {}, signals = UNKNOWN_SIGNALS, extra = {}) => selectRoutingPolicy({ config: { ...config, ...changes }, signals, localOnly: false, metadata, ...extra });
describe('unified routing policy', () => {
  test('difficulty defines the minimum eligible tier', () => {
    for (const [, tier] of [['basic','small'],['standard','medium'],['advanced','large']] as const) {
      expect(route({ mode: 'speed' }, { tier }).ladder.startTier).toBe(tier);
    }
  });
  test('cost selects known lower price across eligible tiers', () => {
    expect(route({ mode: 'cost' }).ladder.startTier).toBe('medium');
    expect(route({ mode: 'cost' }, { ...UNKNOWN_SIGNALS, tier: 'large' }).ladder.startTier).toBe('large');
  });
  test('auto uses configured order without measurements', () => {expect(route({mode:'auto'}).ladder.startTier).toBe('small');});
  test.each(['privacy','speed','cost','auto'])('%s cannot route sensitive input or fallbacks to cloud', mode => {
    const result = route({ mode }, UNKNOWN_SIGNALS, {localOnly: true});
    expect(result.ladder.tiers.flatMap(tier => tier.models).every(model => model.startsWith('local'))).toBe(true);
  });
  test('privacy remains local even for public inputs and fails closed without local candidates', () => {
    expect(route({ mode: 'privacy' }).ladder.tiers[0].models).toEqual(['local-small']);
    expect(route({ mode: 'privacy', localOnly: true, tiers: config.tiers.map(tier => ({ ...tier, models: tier.models.filter(model => !model.startsWith('local')) })) }).ladder.exhausted).toBe(true);
  });
  test('manual escalation and sticky floors cannot be lowered', () => {
    expect(route({ mode: 'speed' }, { ...UNKNOWN_SIGNALS, tier: 'small' }, { minimumTier: 'large' }).ladder.startTier).toBe('large');
  });
  test('missing pricing is not interpreted as free', () => {
    const result = route({ mode: 'cost' }, UNKNOWN_SIGNALS, { metadata: (model: string) => ({ ...metadata(model), pricingUsdPerToken: model === 'cloud-fast' ? { input: null, output: null } : metadata(model).pricingUsdPerToken }) });
    expect(result.ladder.startTier).toBe('medium');
  });
});

test('switching modes changes model assignments without changing classifier tiers', () => {
  const tiers = [{ name: 'small', models: ['cloud-fast'], modelsByMode: { cost: ['cloud-cheap'], privacy: ['local-small'] } }];
  expect(route({ mode: 'cost', tiers }).ladder.tiers[0].models).toEqual(['cloud-cheap']);
  expect(route({ mode: 'privacy', tiers }).ladder.tiers[0].models).toEqual(['local-small']);
});
test('speed uses measurements instead of capability rank', () => {
  const result = route({ mode: 'speed' }, UNKNOWN_SIGNALS, { metadata: (model: string) => ({ ...metadata(model), latencyMs: model === 'cloud-large' ? 10 : 100 }) });
  expect(result.ladder.startTier).toBe('large');
});
test('auto removes a model dominated on both price and measured time', () => {
  const result = route({ mode: 'auto' }, UNKNOWN_SIGNALS, { metadata: (model: string) => ({ ...metadata(model), latencyMs: model === 'cloud-cheap' ? 10 : 100 }) });
  expect(result.ladder.startTier).toBe('medium');
});
test('privacy can choose a trusted endpoint, but explicit local-only cannot', () => {
  const tiers = [{ name: 'small', models: ['cloud-fast', 'trusted'] }];
  const info = (model: string) => ({ ...metadata(model), zone: model === 'trusted' ? 'hai' as const : 'cloud' as const });
  const result = route({ mode: 'privacy', tiers }, UNKNOWN_SIGNALS, { metadata: info });
  expect(result.ladder.tiers[0].models).toEqual(['trusted']);
  expect(route({ mode: 'privacy', tiers, localOnly: true }, UNKNOWN_SIGNALS, { metadata: info }).ladder.exhausted).toBe(true);
});
