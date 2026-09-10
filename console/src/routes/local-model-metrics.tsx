/**
 * Activity graphs render the gateway-owned minute of local-model samples.
 * Unlike capacity recommendations, charts never fill missing readings with zero.
 * Navigation never resets history; this view neither samples nor starts inference.
 */
import type { AdminLocalModelsResponse } from '../api/types';
import styles from './local-model-metrics.module.css';

type Sample = AdminLocalModelsResponse['metricsHistory'][number];
type Reading =
  | 'cpuPercent'
  | 'memoryPercent'
  | 'gpuPercent'
  | 'tokensPerSecond';
// 2026-09-10, owner request: display the gateway's rolling minute at 1Hz;
// actual missing readings remain gaps, independent of browser polling.
const WINDOW_MS = 60_000;

function value(sample: Sample, key: Reading): number | null {
  if (key === 'memoryPercent') {
    return sample.memoryUsedBytes !== null && sample.memoryTotalBytes > 0
      ? (sample.memoryUsedBytes / sample.memoryTotalBytes) * 100
      : null;
  }
  return sample[key];
}

function Graph({
  history,
  reading,
  label,
}: {
  history: Sample[];
  reading: Reading;
  label: string;
}) {
  const maximum =
    reading === 'tokensPerSecond'
      ? Math.max(1, ...history.map((sample) => value(sample, reading) ?? 0))
      : 100;
  const end = history.at(-1)?.sampledAt ?? 0;
  const segments: Array<Array<[number, number]>> = [];
  let segment: Array<[number, number]> = [];
  let previous: Sample | undefined;
  for (const sample of history) {
    const amount = value(sample, reading);
    if (
      amount === null ||
      (previous && sample.sampledAt - previous.sampledAt > 3000) ||
      (reading === 'tokensPerSecond' &&
        previous &&
        (sample.runtimeId !== previous.runtimeId ||
          (sample.generatedTokens !== null &&
            previous.generatedTokens !== null &&
            sample.generatedTokens < previous.generatedTokens)))
    ) {
      if (segment.length) segments.push(segment);
      segment = [];
    }
    if (amount !== null) {
      segment.push([
        2 + Math.max(0, 1 - (end - sample.sampledAt) / WINDOW_MS) * 296,
        50 - Math.min(1, amount / maximum) * 46,
      ]);
    }
    previous = sample;
  }
  if (segment.length) segments.push(segment);
  return (
    <svg
      className={styles.graph}
      viewBox="0 0 300 54"
      preserveAspectRatio="none"
      role="img"
      aria-label={`${label} over the last minute`}
    >
      <path className={styles.baseline} d="M 2 50 H 298" />
      {segments.map((points) => {
        const path = points
          .map(
            ([x, y], index) =>
              `${index ? 'L' : 'M'} ${x.toFixed(2)} ${y.toFixed(2)}`,
          )
          .join(' ');
        return (
          <g key={points[0][0]}>
            <path className={styles.line} d={path} />
            {points.length === 1 && (
              <circle cx={points[0][0]} cy={points[0][1]} r="2" />
            )}
          </g>
        );
      })}
    </svg>
  );
}

export function LocalModelMetrics({
  history,
  running,
  stale,
}: {
  history: Sample[];
  running: boolean;
  stale: boolean;
}) {
  const current = stale ? undefined : history.at(-1);
  const percentage = (key: Reading) => {
    const amount = current ? value(current, key) : null;
    return amount === null ? '—' : `${Math.round(amount)}%`;
  };
  const memory = current?.memoryUsedBytes;
  const cards: Array<{
    label: string;
    reading: Reading;
    display: string;
    detail: string;
  }> = [
    {
      label: 'CPU',
      reading: 'cpuPercent',
      display: percentage('cpuPercent'),
      detail:
        current?.cpuPercent == null
          ? 'Waiting for CPU readings'
          : 'All CPU cores',
    },
    {
      label: 'Memory',
      reading: 'memoryPercent',
      display: percentage('memoryPercent'),
      detail:
        memory == null
          ? 'Memory reading unavailable'
          : `${(memory / 1024 ** 3).toFixed(1)} / ${((current?.memoryTotalBytes ?? 0) / 1024 ** 3).toFixed(1)} GiB · estimated`,
    },
    {
      label: 'GPU',
      reading: 'gpuPercent',
      display: percentage('gpuPercent'),
      detail:
        current?.gpuPercent == null
          ? 'GPU reading unavailable'
          : 'Mac GPU utilization',
    },
    {
      label: 'Tokens',
      reading: 'tokensPerSecond',
      display:
        current?.tokensPerSecond == null
          ? '—'
          : `${current.tokensPerSecond.toFixed(1)} tok/s`,
      detail: !running
        ? 'Model stopped'
        : current?.generatedTokens == null
          ? 'Waiting for runtime counters'
          : `${current.generatedTokens.toLocaleString()} generated · since start`,
    },
  ];
  return (
    <section className={styles.section} aria-label="Local model activity">
      <div className={styles.heading}>
        <h2>Live activity</h2>
        <span>
          {stale ? 'Connection lost · refresh to resume' : 'Last 60 seconds'}
        </span>
      </div>
      <div className={styles.grid}>
        {cards.map((card) => (
          <div className={styles.card} key={card.reading}>
            <div className={styles.reading}>
              <span>{card.label}</span>
              <strong>{card.display}</strong>
            </div>
            <Graph
              history={stale ? [] : history}
              reading={card.reading}
              label={card.label}
            />
            <span className={styles.detail}>{card.detail}</span>
          </div>
        ))}
      </div>
      <p className={styles.caption}>
        CPU, memory and GPU cover this Mac. Tokens include reasoning and tool
        calls.
      </p>
    </section>
  );
}
