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
  test('auto uses configured preferences', () => {
 expect(route({mode:'auto',preference:'asap'}).ladder.startTier).toBe('small');
 expect(route({mode:'auto',preference:'no_hurry'}).ladder.startTier).toBe('medium');
 });
  test.each(['privacy','speed','cost','auto'])('%s cannot route sensitive input or fallbacks to cloud', mode => {
    const result = route({ mode }, UNKNOWN_SIGNALS, {localOnly: true});
    expect(result.ladder.tiers.flatMap(tier => tier.models).every(model => model.startsWith('local'))).toBe(true);
  });
  test('privacy remains local even for public inputs and fails closed without local candidates', () => {
    expect(route({ mode: 'privacy' }).ladder.tiers[0].models).toEqual(['local-small']);
    expect(route({ mode: 'privacy', tiers: config.tiers.map(tier => ({ ...tier, models: tier.models.filter(model => !model.startsWith('local')) })) }).ladder.exhausted).toBe(true);
  });
  test('manual escalation and sticky floors cannot be lowered', () => {
    expect(route({ mode: 'speed' }, { ...UNKNOWN_SIGNALS, tier: 'small' }, { minimumTier: 'large' }).ladder.startTier).toBe('large');
  });
  test('missing pricing is not interpreted as free', () => {
    const result = route({ mode: 'cost' }, UNKNOWN_SIGNALS, { metadata: (model: string) => ({ ...metadata(model), pricingUsdPerToken: model === 'cloud-fast' ? { input: null, output: null } : metadata(model).pricingUsdPerToken }) });
    expect(result.ladder.startTier).toBe('medium');
  });
});
