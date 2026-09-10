/**
 * Local graphs expose bounded numeric host samples and MLX token counters only.
 * Unlike model admission, these readings describe activity, not safe capacity.
 * Sampling never runs a shell, requests privileges, or retains model content.
 */
import { execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';
import type { MacHardware } from './local-model-catalog.js';

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
    running: boolean;
    sample: LocalModelMetrics;
  } | null = null;
  private pending: Promise<LocalModelMetrics> | null = null;

  sample(
    hardware: MacHardware,
    health: Record<string, unknown> | null,
  ): Promise<LocalModelMetrics> {
    if (this.pending) return this.pending;
    const tokens = tokenMetrics(health);
    const previous = this.previous;
    // 2026-09-10, graph implementation choice: coalesce tabs within 1s;
    // the console polls every 2.5s. Continuous background sampling is deferred.
    if (
      previous &&
      performance.now() - previous.time < 1000 &&
      previous.running === Boolean(health) &&
      previous.sample.runtimeId === (tokens?.instanceId ?? null)
    ) {
      return Promise.resolve(previous.sample);
    }
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
    let gpuPercent: number | null = null;
    if (hardware.platform === 'darwin' && hardware.arch === 'arm64') {
      try {
        // 2026-09-10, telemetry safety budget: 1s/2MiB bounds the OS probe;
        // privileged GPU probes are deliberately excluded.
        const { stdout } = await exec(
          '/usr/sbin/ioreg',
          ['-r', '-c', 'IOAccelerator', '-d', '1'],
          {
            encoding: 'utf8',
            timeout: 1000,
            maxBuffer: 2 * 1024 * 1024,
          },
        );
        gpuPercent = parseMacGpuPercent(stdout);
      } catch {
        /* Unavailable is distinct from an idle GPU. */
      }
    }
    const cpu = cpuTimes();
    const now = performance.now();
    const previous = this.previous;
    const total = previous ? cpu.total - previous.cpu.total : 0;
    const idle = previous ? cpu.idle - previous.cpu.idle : 0;
    const available = hardware.availableMemoryEstimateBytes;
    const elapsed = previous ? (now - previous.time) / 1000 : 0;
    // 2026-09-10, graph sampling choice: three missed 2.5s polls break a
    // rate series rather than displaying an average over an unobserved gap.
    const generatedTokens = tokens?.generatedTokens ?? (health ? null : 0);
    const priorTokens = previous?.sample.generatedTokens;
    const tokensPerSecond =
      !health || generatedTokens === 0
        ? 0
        : tokens &&
            previous?.sample.runtimeId === tokens.instanceId &&
            priorTokens != null &&
            tokens.generatedTokens >= priorTokens &&
            elapsed >= 1 &&
            elapsed <= 7.5
          ? (tokens.generatedTokens - priorTokens) / elapsed
          : null;
    const sample: LocalModelMetrics = {
      sampledAt: Date.now(),
      cpuPercent:
        elapsed >= 1 &&
        elapsed <= 7.5 &&
        total > 0 &&
        idle >= 0 &&
        idle <= total
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
    this.previous = { cpu, time: now, running: Boolean(health), sample };
    return sample;
  }
}
