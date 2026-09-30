/**
 * The HybridAI side of the feed: who the gateway's credential belongs to, the
 * two connector tools that report what is new in Gmail and Google Calendar,
 * and the push that tells the user's phone.
 *
 * The connector token and the push key stay on HybridAI; this module only
 * asks, with the credential the gateway already holds. It decides nothing:
 * which events matter and when to notify is `feed.js`.
 */

export const GMAIL_TOOL = 'google_workspace__list_new_messages';
export const CALENDAR_TOOL = 'google_workspace__list_calendar_changes';

const MCP_PATH = '/api/v1/connectors/mcp';
const SHORT_TIMEOUT_MS = 15_000;
// A burst reads up to 60 mail envelopes one by one on the other side.
const TOOL_TIMEOUT_MS = 120_000;

/** A connector tool refused the call. `reconnect` when the connection is dead. */
export class ConnectorError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConnectorError';
    // The gateway words a dead or expired connection with this verb, for the
    // agent and the user alike; every other failure is an outage or a policy.
    this.reconnect = /reconnect/i.test(message);
  }
}

function normalizeBaseUrl(value) {
  const trimmed = String(value || '')
    .trim()
    .replace(/\/+$/, '');
  return trimmed || 'https://hybridai.one';
}

export function createPlatform({ baseUrl, getApiKey, fetchImpl = fetch }) {
  const origin = normalizeBaseUrl(baseUrl);

  async function request(path, { method = 'GET', body, timeoutMs }) {
    const apiKey = getApiKey();
    if (!apiKey) throw new Error('No HybridAI credential is configured.');
    const response = await fetchImpl(`${origin}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`HybridAI answered HTTP ${response.status} on ${path}.`);
    }
    return response.json();
  }

  async function rpc(method, params, timeoutMs) {
    const payload = await request(MCP_PATH, {
      method: 'POST',
      body: { jsonrpc: '2.0', id: 1, method, params },
      timeoutMs,
    });
    if (payload?.error || !payload?.result) {
      throw new Error(`The connector gateway rejected ${method}.`);
    }
    return payload.result;
  }

  return {
    /** The account whose connectors this gateway's credential reads. */
    async accountId() {
      const config = await request('/v1/app-config', {
        timeoutMs: SHORT_TIMEOUT_MS,
      });
      const id = config?.user?.user_id;
      if (typeof id !== 'string' || !id) {
        throw new Error('HybridAI did not say whose credential this is.');
      }
      return id;
    },

    /** Names of the connector tools the account may call right now. */
    async toolNames() {
      const result = await rpc('tools/list', {}, SHORT_TIMEOUT_MS);
      const tools = Array.isArray(result.tools) ? result.tools : [];
      return new Set(tools.map((tool) => tool?.name));
    },

    async callTool(name, args) {
      const result = await rpc(
        'tools/call',
        { name, arguments: args },
        TOOL_TIMEOUT_MS,
      );
      const text = result.content?.[0]?.text;
      if (result.isError === true || typeof text !== 'string') {
        throw new ConnectorError(String(text || `${name} failed`));
      }
      return JSON.parse(text);
    },

    /** Asks HybridAI to notify the account's own phones. */
    async push(notification) {
      return request('/v1/push', {
        method: 'POST',
        body: notification,
        timeoutMs: SHORT_TIMEOUT_MS,
      });
    },
  };
}
