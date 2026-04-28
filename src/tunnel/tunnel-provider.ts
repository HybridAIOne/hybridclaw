export interface TunnelStartResult {
  public_url: string;
}

export interface TunnelStatus {
  running: boolean;
  public_url: string | null;
}

export interface TunnelProvider {
  start(): Promise<TunnelStartResult>;
  stop(): Promise<void>;
  status(): Promise<TunnelStatus>;
}
