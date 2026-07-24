import { beforeEach, expect, test } from 'vitest';
import {
  clearModelRoutingLatenciesForTests,
  getModelRoutingLatencies,
  recordModelRoutingLatency,
} from '../src/gateway/model-routing-latency.js';

beforeEach(() => clearModelRoutingLatenciesForTests());

test('tracks a bounded-lag latency average per model', () => {
  recordModelRoutingLatency('fast', 100);
  recordModelRoutingLatency('fast', 300);
  recordModelRoutingLatency('slow', 800);
  recordModelRoutingLatency('', 1);
  recordModelRoutingLatency('invalid', Number.NaN);

  expect(getModelRoutingLatencies(['fast', 'slow', 'invalid'])).toEqual({
    fast: 150,
    slow: 800,
    invalid: undefined,
  });
});
