import { describe, expect, test } from 'vitest';

import {
  CONTEXT_GUARD_DEFAULTS,
  normalizeContextGuardConfig,
} from '../container/shared/context-guard-config.js';

describe('normalizeContextGuardConfig', () => {
  test('shared defaults match the two-layer context budget policy', () => {
    expect(CONTEXT_GUARD_DEFAULTS).toMatchObject({
      enabled: true,
      perResultShare: 0.3,
      compactionRatio: 0.75,
      overflowRatio: 0.75,
      maxRetries: 3,
    });
  });

  test('clamps the shared guard bounds from one place', () => {
    expect(
      normalizeContextGuardConfig({
        enabled: false,
        perResultShare: 0.01,
        compactionRatio: 2,
        overflowRatio: 0.1,
        maxRetries: 99,
      }),
    ).toEqual({
      enabled: false,
      perResultShare: 0.1,
      compactionRatio: 0.98,
      overflowRatio: 0.98,
      maxRetries: 10,
    });
  });

  test('keeps overflowRatio at least compactionRatio across parsed values', () => {
    expect(
      normalizeContextGuardConfig({
        compactionRatio: '0.5',
        overflowRatio: '0.3',
      }),
    ).toMatchObject({
      compactionRatio: 0.5,
      overflowRatio: 0.5,
    });
  });

  test('falls back to the shared defaults when values are missing', () => {
    expect(normalizeContextGuardConfig(undefined)).toEqual(
      CONTEXT_GUARD_DEFAULTS,
    );
  });
});
