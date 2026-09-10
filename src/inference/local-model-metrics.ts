/**
 * Local graphs expose bounded numeric host samples and MLX token counters only.
 * Unlike model admission, these readings describe activity, not safe capacity.
 * Sampling never runs a shell, requests privileges, or retains model content.
 */
import { execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';
import {
  type MacHardware,
  parseMacAvailableMemory,
} from './local-model-catalog.js';

const exec = promisify(execFile);

export interface LocalModelMetrics {
  sampledAt: number;
  cpuPercent: number | null;
  memoryUsedBytes: number | null;
  memoryTotalBytes: number;
  gpuPercent: number | null;
  tokensPerSecond: number | null;
  generatedTokens: number | null;
  runtimeId: string | null;
}

export function parseMacGpuPercent(output: string): number | null {
  const values = output
    .split('\n')
    .filter((line) => line.includes('"PerformanceStatistics" ='))
    .flatMap((line) =>
      Array.from(
        line.matchAll(/"Device Utilization %"\s*=\s*(\d+(?:\.\d+)?)(?=[,}])/g),
        (match) => Number(match[1]),
      ),
    )
    .filter((value) => value >= 0 && value <= 100);
  return values.length ? Math.max(...values) : null;
}

function tokenMetrics(health: Record<string, unknown> | null) {
  const value = health?.metrics;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { instanceId, generatedTokens } = value as Record<string, unknown>;
  if (
    typeof instanceId !== 'string' ||
    !/^[a-f0-9]{32}$/.test(instanceId) ||
    typeof generatedTokens !== 'number' ||
    !Number.isSafeInteger(generatedTokens) ||
    generatedTokens < 0
  )
    return null;
  return { instanceId, generatedTokens };
}

function cpuTimes() {
  return os.cpus().reduce(
    (sum, cpu) => ({
      idle: sum.idle + cpu.times.idle,
      total: sum.total + Object.values(cpu.times).reduce((a, b) => a + b, 0),
    }),
    { idle: 0, total: 0 },
  );
}

export class LocalModelMetricsSampler {
  private previous: {
    cpu: ReturnType<typeof cpuTimes>;
    time: number;
    sample: LocalModelMetrics;
  } | null = null;
  private pending: Promise<LocalModelMetrics> | null = null;

  sample(
    hardware: MacHardware,
    health: Record<string, unknown> | null,
  ): Promise<LocalModelMetrics> {
    if (this.pending) return this.pending;
    const tokens = tokenMetrics(health);
    this.pending = this.collect(hardware, health, tokens).finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  private async collect(
    hardware: MacHardware,
    health: Record<string, unknown> | null,
    tokens: ReturnType<typeof tokenMetrics>,
  ): Promise<LocalModelMetrics> {
    const cpu = cpuTimes();
    const now = performance.now();
    const sampledAt = Date.now();
    let gpuPercent: number | null = null;
    let available: number | undefined;
    if (hardware.platform === 'darwin' && hardware.arch === 'arm64') {
      // 2026-09-10, telemetry safety budget: bounded asynchronous OS probes
      // keep 1Hz collection off the event loop; privileged probes are excluded.
      const [gpu, memory] = await Promise.allSettled([
        exec('/usr/sbin/ioreg', ['-r', '-c', 'IOAccelerator', '-d', '1'], {
          encoding: 'utf8',
          timeout: 1000,
          maxBuffer: 2 * 1024 * 1024,
        }),
        exec('/usr/bin/vm_stat', [], {
          encoding: 'utf8',
          timeout: 1000,
          maxBuffer: 64 * 1024,
        }),
      ]);
      if (gpu.status === 'fulfilled')
        gpuPercent = parseMacGpuPercent(gpu.value.stdout);
      if (memory.status === 'fulfilled')
        available = parseMacAvailableMemory(memory.value.stdout);
    }
    const previous = this.previous;
    const total = previous ? cpu.total - previous.cpu.total : 0;
    const idle = previous ? cpu.idle - previous.cpu.idle : 0;
    const elapsed = previous ? (now - previous.time) / 1000 : 0;
    // 2026-09-10, 1Hz collection: tolerate timer/probe jitter, but break rates
    // after three seconds instead of averaging across an unobserved gap.
    const generatedTokens = tokens?.generatedTokens ?? (health ? null : 0);
    const priorTokens = previous?.sample.generatedTokens;
    const tokensPerSecond =
      !health || generatedTokens === 0
        ? 0
        : tokens &&
            previous?.sample.runtimeId === tokens.instanceId &&
            priorTokens != null &&
            tokens.generatedTokens >= priorTokens &&
            elapsed > 0 &&
            elapsed <= 3
          ? (tokens.generatedTokens - priorTokens) / elapsed
          : null;
    const sample: LocalModelMetrics = {
      sampledAt,
      cpuPercent:
        elapsed > 0 && elapsed <= 3 && total > 0 && idle >= 0 && idle <= total
          ? (1 - idle / total) * 100
          : null,
      memoryUsedBytes:
        typeof available === 'number' &&
        Number.isFinite(available) &&
        available >= 0 &&
        available <= hardware.memoryBytes
          ? hardware.memoryBytes - available
          : null,
      memoryTotalBytes: hardware.memoryBytes,
      gpuPercent,
      tokensPerSecond,
      generatedTokens,
      runtimeId: tokens?.instanceId ?? null,
    };
    this.previous = { cpu, time: now, sample };
    return sample;
  }
}
