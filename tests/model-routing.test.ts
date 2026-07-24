import { describe, expect, test } from 'vitest';
import {
  type ModelRoutingConfig,
  mostRestrictiveModelRoutingZone,
  normalizeModelRoutingZone,
  orderRoutingModelsByTarget,
  resolveBudgetMaximumTier,
  resolveLadder,
  resolveSensitivityMaximumZone,
  resolveTargetStartTier,
  resolveWeakOutputRetries,
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

test('quality target moves monotonically up the configured ladder', () => {
  const qualities = [0, 0.2, 0.5, 0.8, 1];
  const indexes = qualities.map((quality) =>
    config.tiers.findIndex(
      (tier) => tier.name === resolveTargetStartTier(config.tiers, quality),
    ),
  );
  expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
  expect(indexes[0]).toBe(0);
  expect(indexes.at(-1)).toBe(config.tiers.length - 1);
  expect(resolveWeakOutputRetries(0.74)).toBe(1);
  expect(resolveWeakOutputRetries(0.75)).toBe(0);
});

test('speed target reorders within a rung using measured latency only', () => {
  const models = ['preferred', 'fast', 'slow'];
  const latencies = { preferred: 300, fast: 20, slow: 800 };
  expect(orderRoutingModelsByTarget(models, 0, latencies)).toEqual(models);
  expect(orderRoutingModelsByTarget(models, 1, latencies)).toEqual([
    'fast',
    'preferred',
    'slow',
  ]);
  expect(orderRoutingModelsByTarget(models, 1, { preferred: 300 })).toEqual(
    models,
  );
});

test('sensitivity and budget policies fail closed and clamp monotonically', () => {
  const sensitivityZones = {
    public: 'cloud',
    confidential: 'hai',
  } as const;
  expect(resolveSensitivityMaximumZone('confidential', sensitivityZones)).toBe(
    'hai',
  );
  expect(resolveSensitivityMaximumZone('unknown-label', sensitivityZones)).toBe(
    'local',
  );
  expect(mostRestrictiveModelRoutingZone('cloud', 'region', 'hai')).toBe('hai');
  expect(resolveBudgetMaximumTier(config.tiers, 0)).toBe('advanced');
  expect(resolveBudgetMaximumTier(config.tiers, 0.5)).toBe('general');
  expect(resolveBudgetMaximumTier(config.tiers, 1)).toBe('economy');
});

test('sovereignty filtering never admits a model above the maximum zone', () => {
  for (const maximumZone of ['local', 'hai', 'region', 'cloud'] as const) {
    const resolved = resolveLadder(config, {
      startTier: 'economy',
      maximumZone,
      modelZones,
    });
    const allowed = new Set(
      maximumZone === 'local'
        ? ['local']
        : maximumZone === 'hai'
          ? ['local', 'hai']
          : maximumZone === 'region'
            ? ['local', 'hai', 'region']
            : ['local', 'hai', 'region', 'cloud'],
    );
    for (const model of resolved.tiers.flatMap((tier) => tier.models)) {
      expect(allowed.has(modelZones[model])).toBe(true);
    }
  }
});
