/**
 * Graph rendering preserves gateway history across navigation and missing data.
 * Native counter accuracy is tested separately; these tests cover displayed state.
 */
import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import type { AdminLocalModelsResponse } from '../api/types';
import { LocalModelMetrics } from './local-model-metrics';

type Sample = AdminLocalModelsResponse['metricsHistory'][number];
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
  render(<LocalModelMetrics history={[sample()]} running stale={false} />);
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
      history={[
        sample({
          gpuPercent: null,
          tokensPerSecond: null,
          generatedTokens: null,
        }),
      ]}
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
      history={[
        sample({
          sampledAt: 102_500,
          gpuPercent: 0,
          tokensPerSecond: 0,
          generatedTokens: 0,
          runtimeId: null,
        }),
      ]}
      running={false}
      stale={false}
    />,
  );
  expect(screen.getByText('0%')).toBeDefined();
  expect(screen.getByText('0.0 tok/s')).toBeDefined();
  expect(screen.getByText('Model stopped')).toBeDefined();
});

test('does not draw through missing readings or gaps in gateway sampling', () => {
  const history = [
    sample(),
    sample({ sampledAt: 101_000, gpuPercent: null }),
    sample({ sampledAt: 102_000 }),
  ];
  const { rerender } = render(
    <LocalModelMetrics history={history} running stale={false} />,
  );
  const gpu = screen.getByRole('img', { name: 'GPU over the last minute' });
  expect(gpu.querySelectorAll('g')).toHaveLength(2);
  rerender(
    <LocalModelMetrics
      history={[...history, sample({ sampledAt: 106_000 })]}
      running
      stale={false}
    />,
  );
  expect(gpu.querySelectorAll('g')).toHaveLength(3);
});

test('renders the retained minute on first load and restores intervening samples after navigation', () => {
  const history = Array.from({ length: 60 }, (_, index) =>
    sample({ sampledAt: 100_000 + index * 1000 }),
  );
  const first = render(
    <LocalModelMetrics history={history} running stale={false} />,
  );
  const graph = () =>
    screen.getByRole('img', { name: 'CPU over the last minute' });
  const line = () => graph().querySelector('g path')?.getAttribute('d');
  expect(line()?.match(/L /g)).toHaveLength(59);
  first.unmount();
  // The gateway collected ten more seconds while no graph component existed.
  const returned = [
    ...history.slice(10),
    ...Array.from({ length: 10 }, (_, index) =>
      sample({ sampledAt: 160_000 + index * 1000 }),
    ),
  ];
  const { rerender } = render(
    <LocalModelMetrics history={returned} running stale={false} />,
  );
  const restored = line();
  expect(restored?.match(/L /g)).toHaveLength(59);
  expect(graph().querySelectorAll('g')).toHaveLength(1);
  rerender(<LocalModelMetrics history={returned} running stale />);
  expect(screen.getByText('Connection lost · refresh to resume')).toBeDefined();
  expect(screen.queryByText('20.0 tok/s')).toBeNull();
  expect(graph().querySelectorAll('g')).toHaveLength(0);
  rerender(<LocalModelMetrics history={returned} running stale={false} />);
  expect(line()).toBe(restored);
});

test('keeps host history across runtime restart but breaks the token series', () => {
  render(
    <LocalModelMetrics
      history={[
        sample(),
        sample({ sampledAt: 101_000 }),
        sample({
          sampledAt: 102_000,
          runtimeId: 'b'.repeat(32),
          generatedTokens: 5,
        }),
        sample({
          sampledAt: 103_000,
          runtimeId: 'b'.repeat(32),
          generatedTokens: 15,
        }),
        sample({
          sampledAt: 104_000,
          runtimeId: 'b'.repeat(32),
          generatedTokens: 0,
        }),
      ]}
      running
      stale={false}
    />,
  );
  expect(
    screen
      .getByRole('img', { name: 'CPU over the last minute' })
      .querySelectorAll('g'),
  ).toHaveLength(1);
  expect(
    screen
      .getByRole('img', { name: 'Tokens over the last minute' })
      .querySelectorAll('g'),
  ).toHaveLength(3);
});

test('an empty history waits for samples without inventing activity', () => {
  render(<LocalModelMetrics history={[]} running stale={false} />);
  expect(screen.getByText('Waiting for CPU readings')).toBeDefined();
  expect(screen.getByText('Waiting for runtime counters')).toBeDefined();
  expect(screen.queryByText('0%')).toBeNull();
  expect(screen.queryByText('0.0 tok/s')).toBeNull();
  for (const graph of screen.getAllByRole('img'))
    expect(graph.querySelectorAll('g')).toHaveLength(0);
});
