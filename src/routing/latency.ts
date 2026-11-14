/**
 * Recent successful tool-free execution times inform routing; classifier calls never enter this sample.
 * Approval-only replies never train primary-model latency.
 * Measurements are process-local estimates, not latency guarantees or billing data.
 */
import type { ContainerOutput } from '../types/container.js';

const samples = new Map<string, number[]>();
export function recordRoutingLatency(model: string, durationMs: number): void {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return;
  // Product policy (2026-09-22): bounded recent samples; persistent benchmarks deferred.
  if (!samples.has(model) && samples.size >= 256)
    samples.delete(samples.keys().next().value!);
  const values = [...(samples.get(model) ?? []), durationMs].slice(-20);
  samples.set(model, values);
}

export function recordWorkerRoutingLatency(
  model: string,
  durationMs: number,
  output: ContainerOutput,
): void {
  const primary = output.tokenUsage?.modelUsage
    ?.filter((call) => !call.task)
    .at(-1);
  if (
    output.status === 'success' &&
    !output.toolExecutions?.length &&
    primary?.status === 'success'
  )
    recordRoutingLatency(model, durationMs);
}
export function routingLatencyMs(model: string): number | null {
  const values = samples
    .get(model)
    ?.slice()
    .sort((a, b) => a - b);
  return values?.length ? values[Math.floor(values.length / 2)] : null;
}
