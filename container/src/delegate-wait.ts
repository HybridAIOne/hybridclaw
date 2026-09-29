/**
 * Waiting `delegate` call — asks the gateway to run the children now and
 * returns their reports, which become the parent's tool result.
 *
 * NOT the background path: a `background: true` call is a turn side effect
 * that the gateway starts after the turn (`tools.ts` queues it).
 */
import { postGatewayJson } from './gateway-json-post.js';
import type { DelegationSideEffect } from './types.js';

// Engineering choice, 2026-09-28: a waiting call blocks the turn on its
// children; matches the longest plugin tool window.
const DELEGATE_WAIT_TIMEOUT_MS = 20 * 60_000;

export async function waitForDelegation(params: {
  gatewayBaseUrl: string;
  gatewayApiToken: string;
  sessionId: string;
  effect: DelegationSideEffect;
}): Promise<{ result: string } | { error: string }> {
  const base = params.gatewayBaseUrl.replace(/\/+$/, '');
  if (!base) {
    return {
      error:
        'Error: delegate is unavailable because gatewayBaseUrl is not configured.',
    };
  }
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (params.gatewayApiToken) {
    headers.Authorization = `Bearer ${params.gatewayApiToken}`;
  }
  let response: Awaited<ReturnType<typeof postGatewayJson>>;
  try {
    response = await postGatewayJson(
      `${base}/api/delegate`,
      headers,
      { sessionId: params.sessionId, effect: params.effect },
      DELEGATE_WAIT_TIMEOUT_MS,
    );
  } catch (err) {
    return {
      error: `Error: delegate request failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
  let parsed: { result?: unknown; error?: unknown } | null = null;
  try {
    parsed = JSON.parse(response.text) as { result?: unknown; error?: unknown };
  } catch {
    parsed = null;
  }
  if (response.ok && typeof parsed?.result === 'string') {
    return { result: parsed.result };
  }
  const detail =
    typeof parsed?.error === 'string'
      ? parsed.error
      : response.text || `HTTP ${response.status}`;
  return { error: `Error: delegation failed: ${detail}` };
}
