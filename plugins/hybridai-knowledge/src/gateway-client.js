const GATEWAY_PATH = '/api/v1/connectors/mcp';

/**
 * Calls one HybridAI gateway tool over JSON-RPC and returns its parsed result.
 *
 * The gateway serves `tools/call` over plain JSON with the platform API key
 * as bearer; no session handshake is needed. Tool names are bare here, the
 * `hybridai__` prefix is the agent worker's own namespacing.
 */
export async function callGatewayTool({
  baseUrl,
  apiKey,
  name,
  args,
  timeoutMs,
  fetchImpl = fetch,
}) {
  const url = `${String(baseUrl || 'https://hybridai.one').replace(/\/+$/, '')}${GATEWAY_PATH}`;
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`HybridAI gateway answered ${response.status}`);
  }
  const body = await response.json();
  if (body?.error) {
    throw new Error(String(body.error.message || 'HybridAI gateway error'));
  }
  const result = body?.result ?? {};
  const text = (Array.isArray(result.content) ? result.content : [])
    .filter(
      (item) => item && item.type === 'text' && typeof item.text === 'string',
    )
    .map((item) => item.text)
    .join('\n');
  if (result.isError) {
    throw new Error(text || `${name} failed`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}
