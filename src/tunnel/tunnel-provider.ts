export interface TunnelStartResult {
  // Keep the deployment-facing result shape aligned with runtime config/API
  // fields instead of returning a bare URL string.
  public_url: string;
}

export interface TunnelStatus {
  running: boolean;
  public_url: string | null;
}

export interface TunnelProvider {
  start(): Promise<TunnelStartResult>;
  // Stop is best-effort cleanup: provider shutdown failures should not escape.
  stop(): Promise<void>;
  status(): TunnelStatus;
}
