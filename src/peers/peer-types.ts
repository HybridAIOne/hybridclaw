/**
 * Cross-instance ("hierarchical swarm") peer types.
 *
 * A *peer* is another HybridClaw gateway reachable over HTTP. Two roles:
 * - **outbound**: peers this instance can dispatch tasks to (via the
 *   `delegate_to_peer` tool). Each entry holds the bearer token to send.
 * - **inbound**: tokens this instance accepts when another peer POSTs to
 *   `/api/peer/delegate`. Tokens are matched as bearers and the matching
 *   entry's `id` is recorded in audit events for forensic linkage.
 */

export interface PeerOutboundConfig {
  /** Local label used to look up the peer (e.g. "hc-client-acme"). */
  id: string;
  /** Base URL of the peer gateway, e.g. "https://acme.example/". */
  baseUrl: string;
  /**
   * Bearer token to send in `Authorization` headers when calling this peer.
   * Must match one of the peer's `inboundTokens[].token` entries.
   */
  token: string;
  /** Optional human-readable description of the peer. */
  description?: string;
  /**
   * If set, restricts which agentIds may be requested on the peer.
   * If empty/omitted, any agentId the peer exposes is permitted.
   */
  allowedAgentIds?: string[];
  /** Per-call timeout override (ms). */
  timeoutMs?: number;
}

export interface PeerInboundTokenConfig {
  /**
   * Local label for the inbound peer (used in audit events). Does not have to
   * match the peer's own `instanceId`; it's purely how *this* instance refers
   * to incoming requests authenticated with this token.
   */
  id: string;
  /** Bearer token an inbound peer must present in `Authorization`. */
  token: string;
  /**
   * If set, restricts which local agentIds the inbound peer may request.
   * If empty/omitted, any local agent is reachable.
   */
  allowedAgentIds?: string[];
}

export interface PeersRuntimeConfig {
  enabled: boolean;
  /**
   * Stable identifier for this HybridClaw instance, advertised in the
   * agent card and embedded in cross-instance audit events.
   */
  instanceId: string;
  /** Human label for this instance (advertised in agent card). */
  instanceName: string;
  outbound: PeerOutboundConfig[];
  inboundTokens: PeerInboundTokenConfig[];
  defaultOutboundTimeoutMs: number;
  /** Maximum number of concurrent inbound delegations to accept. */
  inboundMaxConcurrent: number;
}

export const DEFAULT_PEERS_RUNTIME_CONFIG: PeersRuntimeConfig = {
  enabled: false,
  instanceId: '',
  instanceName: '',
  outbound: [],
  inboundTokens: [],
  defaultOutboundTimeoutMs: 60_000,
  inboundMaxConcurrent: 4,
};

/**
 * Public agent card payload served at `/.well-known/hybridclaw-peer.json`.
 *
 * Intentionally minimal — enough for an operator to confirm a peer is reachable
 * and which agents it exposes. Bearer tokens are required for everything else.
 */
export interface PeerAgentCard {
  protocol: 'hybridclaw-peer';
  protocolVersion: '1';
  instanceId: string;
  instanceName: string;
  appVersion: string;
  agents: Array<{
    id: string;
    name?: string | null;
  }>;
  capabilities: {
    delegate: boolean;
    streaming: boolean;
  };
}

/** Body of POST /api/peer/delegate (inbound on the receiving HC). */
export interface PeerDelegateRequest {
  /**
   * Random idempotency / correlation token for this delegation.
   * Echoed back in the response and recorded in audit on both sides.
   */
  taskId: string;
  /** Caller's instanceId (from the calling HC's peer config). */
  parentInstanceId: string;
  /** Caller's audit runId, for forensic linkage. */
  parentRunId?: string;
  /** Caller's session id (informational, not joined to local sessions). */
  parentSessionId?: string;
  /** Local agent id on the receiving HC to run the task as. */
  agentId?: string;
  /** Task content to send to the agent. */
  content: string;
  /** Optional model override on the receiving HC. */
  model?: string;
  /** Optional time budget hint (ms). */
  timeoutMs?: number;
}

export interface PeerDelegateResponse {
  taskId: string;
  /** Receiving HC's instanceId. */
  peerInstanceId: string;
  /** Receiving HC's audit runId for the executed turn (if known). */
  peerRunId?: string;
  /** Receiving HC's session id where the work was recorded. */
  peerSessionId?: string;
  status: 'success' | 'error' | 'rejected';
  result: string | null;
  error?: string;
  toolsUsed?: string[];
  agentId?: string;
  model?: string;
  /**
   * Set when the receiving HC could not finish because an approval was
   * required. The caller surfaces this back to its operator since the peer
   * cannot prompt the calling instance's user directly.
   */
  pendingApprovalSummary?: string | null;
}
