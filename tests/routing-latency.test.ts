import { expect, test } from 'vitest';
import type { ModelCallUsage } from '../container/shared/token-usage.js';
import { createTokenUsageStats } from '../container/shared/token-usage.js';
import {
  recordRoutingLatency,
  recordWorkerRoutingLatency,
  routingLatencyMs,
} from '../src/routing/latency.js';
import type { ContainerOutput } from '../src/types/container.js';

test('latency estimates ignore invalid samples and bound recent measurements', () => {
  const model = 'test/latency';
  expect(routingLatencyMs(model)).toBeNull();
  for (const invalid of [0, -1, Infinity, NaN])
    recordRoutingLatency(model, invalid);
  expect(routingLatencyMs(model)).toBeNull();
  for (let i = 0; i < 20; i++) recordRoutingLatency(model, 1000);
  for (let i = 0; i < 20; i++) recordRoutingLatency(model, 10);
  expect(routingLatencyMs(model)).toBe(10);
});

test('worker latency requires a completed primary response and no tools', () => {
  const call = (
    task?: string,
    status: ModelCallUsage['status'] = 'success',
  ): ModelCallUsage => ({
    model: 'test/primary',
    ...(task ? { task } : {}),
    status,
    durationMs: 10,
    usage: { ...createTokenUsageStats(), modelCalls: 1 },
  });
  const output = (modelUsage: ModelCallUsage[]): ContainerOutput => ({
    status: 'success',
    result: 'Fixture complete.',
    toolsUsed: [],
    toolExecutions: [],
    tokenUsage: {
      ...createTokenUsageStats(),
      modelCalls: modelUsage.length,
      modelUsage,
    },
  });
  const ignored: ContainerOutput[] = [
    output([]),
    output([call('eval_judge')]),
    output([call(undefined, 'error')]),
    { ...output([call()]), status: 'error' },
    {
      ...output([call()]),
      toolExecutions: [
        { name: 'read', arguments: '{}', result: 'Fixture.', durationMs: 1 },
      ],
    },
  ];
  ignored.forEach((entry, index) => {
    const model = `test/unmeasured-${index}`;
    recordWorkerRoutingLatency(model, 10, entry);
    expect(routingLatencyMs(model)).toBeNull();
  });
  recordWorkerRoutingLatency('test/measured-primary', 10, output([call()]));
  expect(routingLatencyMs('test/measured-primary')).toBe(10);
});
