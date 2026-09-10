/**
 * Gateway-owned activity history survives page navigation and multiple viewers.
 * Unlike the sampler, this store owns cadence and bounded retention, not probes.
 * It retains numeric samples in memory only; no model content or durable logs.
 */
import type { LocalModelMetrics } from './local-model-metrics.js';

// 2026-09-10, owner request: collect at 1Hz even without a viewer. Retain the
// existing one-minute graph window; disk storage and longer retention deferred.
const INTERVAL_MS = 1000;
const WINDOW_MS = 60_000;

export class LocalModelMetricsHistory {
  private samples: LocalModelMetrics[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private pending: Promise<void> | null = null;
  private closed = false;

  constructor(private readonly collect: () => Promise<LocalModelMetrics>) {}

  start(): void {
    if (this.closed || this.timer) return;
    this.timer = setInterval(() => this.tick(), INTERVAL_MS);
    this.timer.unref();
    this.tick();
  }

  snapshot(): LocalModelMetrics[] {
    const now = Date.now();
    return this.samples
      .filter(
        (sample) =>
          sample.sampledAt > now - WINDOW_MS && sample.sampledAt <= now,
      )
      .map((sample) => ({ ...sample }));
  }

  private tick(): void {
    if (this.closed || this.pending) return;
    this.pending = this.collect()
      .then((sample) => {
        if (this.closed) return;
        const previous = this.samples.at(-1);
        if (previous && previous.sampledAt >= sample.sampledAt)
          this.samples = [];
        this.samples = [
          ...this.samples.filter(
            (entry) => entry.sampledAt > sample.sampledAt - WINDOW_MS,
          ),
          sample,
        ].slice(-60);
      })
      .catch(() => {
        // A failed probe leaves a real gap; raw errors may contain runtime data.
      })
      .finally(() => {
        this.pending = null;
      });
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.pending;
    this.samples = [];
  }
}
