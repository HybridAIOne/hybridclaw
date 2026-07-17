import { describe, expect, test } from 'vitest';
import {
  type ModelRoutingConfig,
  normalizeModelRoutingZone,
  resolveLadder,
} from '../src/providers/model-routing.js';

const config: ModelRoutingConfig = {
  enabled: true,
  tiers: [
    { name: 'economy', models: ['edge/small'] },
    {
      name: 'general',
      models: ['hai/medium', 'regional/medium'],
    },
    { name: 'advanced', models: ['cloud/frontier'] },
  ],
  defaultStart: 'general',
  escalationStickyTurns: 3,
};

const modelZones = {
  'edge/small': 'local',
  'hai/medium': 'hai',
  'regional/medium': 'region',
  'cloud/frontier': 'cloud',
} as const;

describe('resolveLadder', () => {
  test('returns no active ladder when routing is disabled', () => {
    expect(resolveLadder({ ...config, enabled: false })).toEqual({
      enabled: false,
      tiers: [],
      startTier: null,
      startIndex: -1,
      referenceModel: null,
      reason: 'disabled',
      exhausted: false,
    });
  });

  test('uses the configured default and highest allowed primary as reference', () => {
    const resolved = resolveLadder(config, { modelZones });

    expect(resolved.startTier).toBe('general');
    expect(resolved.startIndex).toBe(1);
    expect(resolved.referenceModel).toBe('cloud/frontier');
    expect(resolved.reason).toBe('default-start');
    expect(resolved.exhausted).toBe(false);
  });

  test('applies start, capability floor, and sticky floors in ladder order', () => {
    expect(
      resolveLadder(config, { startTier: 'economy', modelZones }).startTier,
    ).toBe('economy');
    expect(
      resolveLadder(config, {
        startTier: 'economy',
        minimumTier: 'general',
        modelZones,
      }),
    ).toMatchObject({ startTier: 'general', reason: 'minimum-tier' });
    expect(
      resolveLadder(config, {
        startTier: 'economy',
        stickyTier: 'advanced',
        modelZones,
      }),
    ).toMatchObject({ startTier: 'advanced', reason: 'sticky-tier' });
  });

  test('filters by sovereignty, skips empty rungs, and fails closed', () => {
    const sovereign = resolveLadder(config, {
      startTier: 'economy',
      maximumZone: 'hai',
      modelZones,
    });
    expect(sovereign.tiers.map((tier) => tier.name)).toEqual([
      'economy',
      'general',
    ]);
    expect(sovereign.tiers[1]?.models).toEqual(['hai/medium']);
    expect(sovereign.referenceModel).toBe('hai/medium');

    expect(
      resolveLadder(config, {
        startTier: 'advanced',
        maximumZone: 'hai',
        modelZones,
      }),
    ).toMatchObject({
      startTier: null,
      reason: 'no-eligible-models',
      exhausted: true,
    });
  });

  test('does not violate a floor when the maximum tier is lower', () => {
    expect(
      resolveLadder(config, {
        minimumTier: 'advanced',
        maximumTier: 'general',
        modelZones,
      }),
    ).toMatchObject({
      startTier: null,
      reason: 'no-eligible-models',
      exhausted: true,
    });
  });

  test('throws for context tier names outside the configured ladder', () => {
    expect(() =>
      resolveLadder(config, { startTier: 'hardcoded-name', modelZones }),
    ).toThrow('unknown routing tier');
  });
});

test('unknown zones default to cloud', () => {
  expect(normalizeModelRoutingZone(undefined)).toBe('cloud');
  expect(normalizeModelRoutingZone('unclassified')).toBe('cloud');
  expect(normalizeModelRoutingZone('HAI')).toBe('hai');
});
