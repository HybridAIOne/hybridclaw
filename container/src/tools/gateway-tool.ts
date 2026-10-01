/**
 * A tool whose state lives on the gateway (`todo`, `track`): the arguments go
 * to one gateway route on the calling session, and the answer comes back as
 * text. Lists kept there outlive the worker, and apps see the same ones.
 */
export interface GatewayToolTarget {
  baseUrl: string;
  apiToken: string;
  sessionId: string;
}

export async function postGatewayTool(
  route: string,
  what: string,
  args: Record<string, unknown>,
  gateway: GatewayToolTarget,
): Promise<{ ok: boolean; text: string }> {
  const base = gateway.baseUrl.replace(/\/+$/, '');
  if (!base) {
    return {
      ok: false,
      text: `Error: ${what} are unavailable because gatewayBaseUrl is not configured.`,
    };
  }
  let response: Response;
  try {
    response = await fetch(`${base}${route}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(gateway.apiToken
          ? { Authorization: `Bearer ${gateway.apiToken}` }
          : {}),
      },
      body: JSON.stringify({ ...args, sessionId: gateway.sessionId }),
    });
  } catch (err) {
    return {
      ok: false,
      text: `Error: ${route} request failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const rawText = await response.text();
  let parsed: { ok?: unknown; result?: unknown; error?: unknown } | null;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    parsed = null;
  }
  if (response.ok && parsed?.ok === true && typeof parsed.result === 'string') {
    return { ok: true, text: parsed.result };
  }
  const detail =
    typeof parsed?.error === 'string' && parsed.error.trim()
      ? parsed.error
      : rawText || `HTTP ${response.status}`;
  return { ok: false, text: `Error: ${detail}` };
}
