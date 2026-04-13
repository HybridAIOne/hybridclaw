export interface HumanDelayConfig {
  mode: 'off' | 'natural' | 'custom';
  minMs?: number;
  maxMs?: number;
}

export interface ResolvedHumanDelayConfig {
  mode: 'off' | 'natural' | 'custom';
  minMs: number;
  maxMs: number;
}

export const DEFAULT_HUMAN_DELAY_MIN_MS = 800;
export const DEFAULT_HUMAN_DELAY_MAX_MS = 2_500;

export function resolveHumanDelayConfig(
  config?: HumanDelayConfig,
): ResolvedHumanDelayConfig {
  const mode = config?.mode ?? 'natural';
  const minMs = Math.max(
    0,
    Math.floor(config?.minMs ?? DEFAULT_HUMAN_DELAY_MIN_MS),
  );
  const rawMax = Math.max(
    0,
    Math.floor(config?.maxMs ?? DEFAULT_HUMAN_DELAY_MAX_MS),
  );
  const maxMs = Math.max(minMs, rawMax);
  return {
    mode,
    minMs,
    maxMs,
  };
}

export function getHumanDelayMs(config?: HumanDelayConfig): number {
  const resolved = resolveHumanDelayConfig(config);
  if (resolved.mode === 'off') return 0;
  if (resolved.maxMs <= resolved.minMs) return resolved.minMs;
  const span = resolved.maxMs - resolved.minMs + 1;
  return resolved.minMs + Math.floor(Math.random() * span);
}
