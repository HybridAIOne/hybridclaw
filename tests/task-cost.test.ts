import { describe, expect, test, vi } from 'vitest';

vi.mock('../src/providers/model-catalog.js', () => ({
  getModelCatalogMetadata: (model: string) => ({
    pricingUsdPerToken:
      model === 'unpriced'
        ? { input: null, output: null, cacheRead: null, cacheWrite: null }
        : {
            input: 2 / 1_000_000,
            output: 10 / 1_000_000,
            cacheRead: 0.2 / 1_000_000,
            cacheWrite: null,
          },
  }),
}));

import type {
  RoutingTrace,
  RoutingTraceAttempt,
} from '../src/types/routing-trace.js';
import {
  estimateTaskCost,
  rememberTaskCostEstimate,
  takeTaskCostEstimate,
  taskCostFromRoutingTrace,
} from '../src/usage/task-cost.js';

function attempt(fields: Partial<RoutingTraceAttempt>): RoutingTraceAttempt {
  return {
    id: 1,
    kind: 'execution',
    model: 'hybridai/gpt-paid',
    zone: 'cloud',
    reason: 'selected-model',
    tier: null,
    status: 'success',
    durationMs: 900,
    inputTokens: 1_000,
    outputTokens: 100,
    totalTokens: 1_100,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    tokensEstimated: false,
    costUsd: 0.1712,
    costSource: 'estimated',
    modelCalls: 4,
    ...fields,
  };
}

function trace(...attempts: RoutingTraceAttempt[]): RoutingTrace {
  return {
    version: 1,
    status: 'complete',
    mode: 'direct',
    attempts,
    durationMs: 1_000,
  };
}

const isFree = (model: string) => model === 'hybridai/gpt-free';

describe('task cost', () => {
  test('adds every model request in euros and counts the requests', () => {
    const cost = taskCostFromRoutingTrace(
      trace(
        attempt({}),
        attempt({ id: 2, kind: 'auxiliary', costUsd: 0.1, modelCalls: 1 }),
      ),
      isFree,
    );
    expect(cost).toEqual({ eur: 0.2316, free: false, requests: 5 });
  });

  test('charges nothing for a free-tier model, which still uses requests', () => {
    expect(
      taskCostFromRoutingTrace(
        trace(attempt({ model: 'hybridai/gpt-free' })),
        isFree,
      ),
    ).toEqual({ eur: 0, free: true, requests: 4 });
  });

  test('says nothing it does not know', () => {
    expect(taskCostFromRoutingTrace(trace(), isFree)).toBeNull();
    expect(
      taskCostFromRoutingTrace(
        trace(attempt({ costUsd: null, modelCalls: undefined })),
        isFree,
      ),
    ).toEqual({ eur: null, free: false, requests: null });
    // A model on the user's own machine costs nothing, priced or not.
    expect(
      taskCostFromRoutingTrace(
        trace(attempt({}), attempt({ id: 2, zone: 'local', costUsd: null })),
        isFree,
      )?.eur,
    ).toBe(0.1462);
  });
});

describe('task cost estimate', () => {
  test('gives a range around the likely cost of the steps', () => {
    const estimate = estimateTaskCost({
      model: 'hybridai/gpt-paid',
      steps: 20,
      contextTokens: 30_000,
      isFree,
    });
    // 885,000 input tokens at 80 % cached, 10,000 output tokens: $0.5956,
    // €0.5085 in the middle.
    expect(estimate).toEqual({
      low: 0.3,
      high: 0.82,
      free: false,
      requests: 20,
    });
  });

  test('is free on a free-tier model and missing without a price', () => {
    expect(
      estimateTaskCost({
        model: 'hybridai/gpt-free',
        steps: 12,
        contextTokens: null,
        isFree,
      }),
    ).toEqual({ low: 0, high: 0, free: true, requests: 12 });
    expect(
      estimateTaskCost({
        model: 'unpriced',
        steps: 12,
        contextTokens: null,
        isFree,
      }),
    ).toBeNull();
  });

  test('is shown once, by the turn that asked for it', () => {
    const estimate = { low: 0.1, high: 0.3, free: false, requests: 20 };
    rememberTaskCostEstimate('session-a', estimate);
    expect(takeTaskCostEstimate('session-b')).toBeUndefined();
    expect(takeTaskCostEstimate('session-a')).toEqual(estimate);
    expect(takeTaskCostEstimate('session-a')).toBeUndefined();
  });
});
