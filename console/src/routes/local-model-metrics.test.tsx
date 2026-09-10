/**
 * Graph rendering preserves missing-data gaps and bounds retained samples.
 * Native counter accuracy is tested separately; these tests cover displayed state.
 */
import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import type { AdminLocalModelsResponse } from '../api/types';
import { LocalModelMetrics } from './local-model-metrics';

type Sample = AdminLocalModelsResponse['metrics'];
const sample = (overrides: Partial<Sample> = {}): Sample => ({
  sampledAt: 100_000,
  cpuPercent: 25,
  memoryUsedBytes: 24 * 1024 ** 3,
  memoryTotalBytes: 32 * 1024 ** 3,
  gpuPercent: 60,
  tokensPerSecond: 20,
  generatedTokens: 100,
  runtimeId: 'a'.repeat(32),
  ...overrides,
});

test('shows four labeled graphs with host memory and actual model throughput', () => {
  render(<LocalModelMetrics sample={sample()} running stale={false} />);
  expect(screen.getAllByRole('img')).toHaveLength(4);
  expect(screen.getByText('25%')).toBeDefined();
  expect(screen.getByText('75%')).toBeDefined();
  expect(screen.getByText('60%')).toBeDefined();
  expect(screen.getByText('20.0 tok/s')).toBeDefined();
  expect(screen.getByText('24.0 / 32.0 GiB · estimated')).toBeDefined();
  expect(screen.getByText('100 generated · since start')).toBeDefined();
});

test('missing readings remain unavailable while idle readings show zero', () => {
  const { rerender } = render(
    <LocalModelMetrics
      sample={sample({
        gpuPercent: null,
        tokensPerSecond: null,
        generatedTokens: null,
      })}
      running
      stale={false}
    />,
  );
  expect(screen.getByText('GPU reading unavailable')).toBeDefined();
  expect(screen.getByText('Waiting for runtime counters')).toBeDefined();
  expect(
    screen
      .getByRole('img', { name: 'GPU over the last minute' })
      .querySelectorAll('g'),
  ).toHaveLength(0);
  expect(screen.queryByText('0%')).toBeNull();
  rerender(
    <LocalModelMetrics
      sample={sample({
        sampledAt: 102_500,
        gpuPercent: 0,
        tokensPerSecond: 0,
        generatedTokens: 0,
        runtimeId: null,
      })}
      running={false}
      stale={false}
    />,
  );
  expect(screen.getByText('0%')).toBeDefined();
  expect(screen.getByText('0.0 tok/s')).toBeDefined();
  expect(screen.getByText('Model stopped')).toBeDefined();
});

test('does not draw through missing samples or long polling gaps', () => {
  const { rerender } = render(
    <LocalModelMetrics sample={sample()} running stale={false} />,
  );
  rerender(
    <LocalModelMetrics
      sample={sample({ sampledAt: 102_500, gpuPercent: null })}
      running
      stale={false}
    />,
  );
  rerender(
    <LocalModelMetrics
      sample={sample({ sampledAt: 105_000 })}
      running
      stale={false}
    />,
  );
  const gpu = screen.getByRole('img', { name: 'GPU over the last minute' });
  expect(gpu.querySelectorAll('g')).toHaveLength(2);
  rerender(
    <LocalModelMetrics
      sample={sample({ sampledAt: 120_000 })}
      running
      stale={false}
    />,
  );
  expect(gpu.querySelectorAll('g')).toHaveLength(3);
});

test('keeps a bounded rolling history and resets graphs on runtime restart or connection failure', () => {
  const { rerender } = render(
    <LocalModelMetrics sample={sample()} running stale={false} />,
  );
  for (let index = 1; index <= 40; index++) {
    rerender(
      <LocalModelMetrics
        sample={sample({ sampledAt: 100_000 + index * 2500 })}
        running
        stale={false}
      />,
    );
  }
  const graph = screen.getByRole('img', { name: 'CPU over the last minute' });
  const line = graph.querySelector('g path:last-of-type');
  expect(line?.getAttribute('d')?.match(/L /g)).toHaveLength(24);
  rerender(
    <LocalModelMetrics
      sample={sample({ sampledAt: 202_500, runtimeId: 'b'.repeat(32) })}
      running
      stale={false}
    />,
  );
  expect(graph.querySelectorAll('circle')).toHaveLength(1);
  rerender(<LocalModelMetrics sample={sample()} running stale />);
  expect(screen.getByText('Connection lost · refresh to resume')).toBeDefined();
  expect(screen.queryByText('20.0 tok/s')).toBeNull();
  expect(graph.querySelectorAll('g')).toHaveLength(0);
});
