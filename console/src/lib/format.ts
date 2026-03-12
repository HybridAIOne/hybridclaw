export function formatCompactNumber(value: number): string {
  return new Intl.NumberFormat('en', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value);
}

export function formatUsd(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: value >= 1 ? 2 : 4,
    maximumFractionDigits: value >= 1 ? 2 : 6,
  }).format(value);
}

export function formatRelativeTime(raw: string): string {
  const timestamp = new Date(raw);
  if (Number.isNaN(timestamp.getTime())) return 'unknown';
  const deltaMs = Date.now() - timestamp.getTime();
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (deltaMs < minute) return 'just now';
  if (deltaMs < hour) return `${Math.floor(deltaMs / minute)}m ago`;
  if (deltaMs < day) return `${Math.floor(deltaMs / hour)}h ago`;
  return `${Math.floor(deltaMs / day)}d ago`;
}

export function formatDateTime(raw: string | null): string {
  if (!raw) return 'never';
  const timestamp = new Date(raw);
  if (Number.isNaN(timestamp.getTime())) return 'unknown';
  return timestamp.toLocaleString();
}

export function formatUptime(totalSeconds: number): string {
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const parts = [
    days ? `${days}d` : null,
    hours ? `${hours}h` : null,
    `${minutes}m`,
  ].filter(Boolean);
  return parts.join(' ');
}

export function parseStringList(value: string): string[] {
  return value
    .split(/[\n,]/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function joinStringList(value: string[] | undefined): string {
  return (value || []).join(', ');
}
