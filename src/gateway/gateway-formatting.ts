export function formatCompactNumber(value: number | null): string {
  if (value == null) return 'n/a';
  const abs = Math.abs(value);
  if (abs >= 1_000_000) {
    const scaled =
      abs >= 10_000_000
        ? (value / 1_000_000).toFixed(0)
        : (value / 1_000_000).toFixed(1);
    return `${scaled.replace(/\.0$/, '')}M`;
  }
  if (abs >= 1_000) {
    const scaled =
      abs >= 10_000 ? (value / 1_000).toFixed(0) : (value / 1_000).toFixed(1);
    return `${scaled.replace(/\.0$/, '')}k`;
  }
  return String(Math.round(value));
}

export function abbreviateForUser(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

export function formatRalphIterations(value: number): string {
  if (value === -1) return 'unlimited';
  if (value <= 0) return 'off';
  return `${value} extra iteration${value === 1 ? '' : 's'}`;
}

export function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}

export function formatPercent(value: number | null): string {
  if (value == null || Number.isNaN(value) || !Number.isFinite(value))
    return 'n/a';
  return `${Math.max(0, Math.min(100, Math.round(value)))}%`;
}

function formatThroughput(throughput: number): string {
  const rounded =
    throughput >= 100
      ? Math.round(throughput)
      : Math.round(throughput * 10) / 10;
  return String(rounded);
}

function formatTokensPerSecond(value: number | null): string {
  if (value == null || Number.isNaN(value) || !Number.isFinite(value))
    return 'n/a tok/s';
  return `${formatThroughput(value)} tok/s`;
}

export function formatPerformanceTokensPerSecond(
  value: number | null,
  stddev: number | null,
): string {
  if (value == null || Number.isNaN(value) || !Number.isFinite(value)) {
    return 'n/a';
  }
  const stddevLabel =
    stddev != null && Number.isFinite(stddev)
      ? formatThroughput(Math.max(0, stddev))
      : 'n/a';
  return `${formatTokensPerSecond(value)} (± ${stddevLabel})`;
}

export function formatUsd(value: number | null): string {
  if (value == null || Number.isNaN(value) || !Number.isFinite(value)) {
    return 'n/a';
  }
  if (value <= 0) return '$0.0000';
  if (value >= 1) return `$${value.toFixed(2)}`;
  if (value >= 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(6)}`;
}
