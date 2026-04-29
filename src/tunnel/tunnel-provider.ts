export interface TunnelStartResult {
  // Keep the deployment-facing result shape aligned with runtime config/API
  // fields instead of returning a bare URL string.
  public_url: string;
}

export const DEFAULT_TUNNEL_HEALTH_CHECK_INTERVAL_MS = 30_000;
export const DEFAULT_TUNNEL_HEALTH_CHECK_TIMEOUT_MS = 5_000;
export const DEFAULT_TUNNEL_RECONNECT_INITIAL_BACKOFF_MS = 1_000;
export const DEFAULT_TUNNEL_RECONNECT_MAX_BACKOFF_MS = 30_000;

export type TunnelState = 'down' | 'starting' | 'up' | 'reconnecting';

export interface TunnelStatus {
  running: boolean;
  public_url: string | null;
  state: TunnelState;
  last_error: string | null;
  last_checked_at: string | null;
  next_reconnect_at: string | null;
  reconnect_attempt: number;
}

export interface TunnelProvider {
  start(): Promise<TunnelStartResult>;
  // Stop is best-effort cleanup: provider shutdown failures should not escape.
  stop(): Promise<void>;
  status(): TunnelStatus;
}
