import { logger } from '../logger.js';
import {
  ensureOutboundAgentAllowed,
  getDefaultOutboundTimeoutMs,
  getOutboundPeer,
} from './peer-registry.js';
import type {
  PeerAgentCard,
  PeerDelegateRequest,
  PeerDelegateResponse,
  PeerOutboundConfig,
} from './peer-types.js';

const PEER_DELEGATE_PATH = '/api/peer/delegate';
const PEER_AGENT_CARD_PATH = '/.well-known/hybridclaw-peer.json';

class PeerHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = 'PeerHttpError';
  }
}

function joinUrl(baseUrl: string, pathname: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${pathname}`;
}

function isPeerAgentCard(value: unknown): value is PeerAgentCard {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    v.protocol === 'hybridclaw-peer' &&
    typeof v.instanceId === 'string' &&
    typeof v.appVersion === 'string' &&
    Array.isArray(v.agents)
  );
}

function isPeerDelegateResponse(value: unknown): value is PeerDelegateResponse {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.taskId === 'string' &&
    typeof v.peerInstanceId === 'string' &&
    (v.status === 'success' || v.status === 'error' || v.status === 'rejected')
  );
}

export async function fetchPeerAgentCard(
  peerId: string,
  signal?: AbortSignal,
): Promise<PeerAgentCard> {
  const peer = getOutboundPeer(peerId);
  if (!peer) {
    throw new Error(`Unknown peer id "${peerId}".`);
  }
  return fetchPeerAgentCardFromConfig(peer, signal);
}

async function fetchPeerAgentCardFromConfig(
  peer: PeerOutboundConfig,
  signal?: AbortSignal,
): Promise<PeerAgentCard> {
  const url = joinUrl(peer.baseUrl, PEER_AGENT_CARD_PATH);
  const response = await fetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new PeerHttpError(
      `Peer "${peer.id}" agent card returned HTTP ${response.status}`,
      response.status,
      text,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new PeerHttpError(
      `Peer "${peer.id}" agent card returned invalid JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
      response.status,
      text,
    );
  }
  if (!isPeerAgentCard(parsed)) {
    throw new PeerHttpError(
      `Peer "${peer.id}" agent card has unexpected shape.`,
      response.status,
      text,
    );
  }
  return parsed;
}

export interface PeerDelegateOptions {
  peerId: string;
  request: PeerDelegateRequest;
  signal?: AbortSignal;
}

export async function delegateToPeer(
  options: PeerDelegateOptions,
): Promise<PeerDelegateResponse> {
  const peer = getOutboundPeer(options.peerId);
  if (!peer) {
    throw new Error(`Unknown peer id "${options.peerId}".`);
  }
  ensureOutboundAgentAllowed(peer, options.request.agentId);

  const timeoutMs =
    options.request.timeoutMs ||
    peer.timeoutMs ||
    getDefaultOutboundTimeoutMs();
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener('abort', () => controller.abort());
  }

  let response: Response;
  try {
    response = await fetch(joinUrl(peer.baseUrl, PEER_DELEGATE_PATH), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${peer.token}`,
      },
      body: JSON.stringify(options.request),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeoutHandle);
    if ((err as Error).name === 'AbortError') {
      throw new Error(
        `Peer "${peer.id}" delegation timed out after ${timeoutMs}ms`,
      );
    }
    throw new Error(
      `Peer "${peer.id}" delegation request failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  clearTimeout(timeoutHandle);

  const text = await response.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }

  if (!response.ok) {
    const errorMessage =
      parsed && typeof (parsed as Record<string, unknown>).error === 'string'
        ? String((parsed as Record<string, unknown>).error)
        : `HTTP ${response.status}`;
    logger.warn(
      {
        peerId: peer.id,
        status: response.status,
        taskId: options.request.taskId,
      },
      'Peer delegation rejected',
    );
    throw new PeerHttpError(errorMessage, response.status, text);
  }

  if (!isPeerDelegateResponse(parsed)) {
    throw new PeerHttpError(
      `Peer "${peer.id}" returned malformed delegation response.`,
      response.status,
      text,
    );
  }
  return parsed;
}

export { PeerHttpError };
