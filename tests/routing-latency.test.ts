import { expect, test } from 'vitest';
import { recordRoutingLatency, routingLatencyMs } from '../src/routing/latency.js';

test('latency estimates ignore invalid samples and bound recent measurements', () => {
  const model = 'test/latency';
  expect(routingLatencyMs(model)).toBeNull();
  for (const invalid of [0, -1, Infinity, NaN]) recordRoutingLatency(model, invalid);
  expect(routingLatencyMs(model)).toBeNull();
  for (let i = 0; i < 20; i++) recordRoutingLatency(model, 1000);
  for (let i = 0; i < 20; i++) recordRoutingLatency(model, 10);
  expect(routingLatencyMs(model)).toBe(10);
});
