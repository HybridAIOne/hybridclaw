import { GATEWAY_API_TOKEN, GATEWAY_BASE_URL } from './config.js';
import {
  renderGatewayCommand,
  type GatewayChatRequestBody,
  type GatewayChatResult,
  type GatewayCommandRequest,
  type GatewayCommandResult,
  type GatewayChatStreamEvent,
  type GatewayChatStreamResultEvent,
  type GatewayChatToolProgressEvent,
  type GatewayStatus,
} from './gateway-types.js';
export { renderGatewayCommand };
export type { GatewayChatResult, GatewayCommandResult, GatewayStatus, GatewayChatStreamEvent };
export type GatewayChatRequest = GatewayChatRequestBody;

function gatewayUrl(pathname: string): string {
  const base = GATEWAY_BASE_URL.replace(/\/+$/, '');
  const path = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return `${base}${path}`;
}

function authHeaders(): Record<string, string> {
  if (!GATEWAY_API_TOKEN) return {};
  return { Authorization: `Bearer ${GATEWAY_API_TOKEN}` };
}

async function requestJson<T>(pathname: string, init: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(gatewayUrl(pathname), init);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Gateway request failed (${GATEWAY_BASE_URL}): ${detail}`);
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof payload.error === 'string' ? payload.error : `${response.status} ${response.statusText}`;
    throw new Error(`Gateway error: ${message}`);
  }
  return payload as T;
}

export async function gatewayCommand(params: GatewayCommandRequest): Promise<GatewayCommandResult> {
  return requestJson<GatewayCommandResult>('/api/command', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
    },
    body: JSON.stringify(params),
  });
}

export async function gatewayChat(
  params: GatewayChatRequest,
  signal?: AbortSignal,
): Promise<GatewayChatResult> {
  return requestJson<GatewayChatResult>('/api/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
    },
    body: JSON.stringify(params),
    signal,
  });
}

export async function gatewayChatStream(
  params: GatewayChatRequest & { stream: true },
  onEvent: (event: GatewayChatStreamEvent) => void,
  signal?: AbortSignal,
): Promise<GatewayChatResult> {
  const response = await fetch(gatewayUrl('/api/chat'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/x-ndjson',
      ...authHeaders(),
    },
    body: JSON.stringify({ ...params, stream: true }),
    signal,
  });

  if (!response.ok) {
    const errorText = (await response.text().catch(() => '')).trim() || `${response.status} ${response.statusText}`;
    throw new Error(`Gateway error: ${errorText}`);
  }

  const parser = createResponseParser(onEvent);
  if (!response.body) {
    const text = (await response.text().catch(() => '')).trim() || `${response.status} ${response.statusText}`;
    const parsed = parser(text);
    if (!parsed || parsed.type !== 'result') {
      throw new Error(`Malformed gateway response: ${text}`);
    }
    return parsed.result;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finalResult: GatewayChatResult | null = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const raw of lines) {
        const parsed = parser(raw);
        if (parsed?.type === 'result') {
          finalResult = parsed.result;
        }
      }
    }

    if (buffer.trim()) {
      const parsed = parser(buffer);
      if (parsed?.type === 'result') {
        finalResult = parsed.result;
      }
    }
  } finally {
    reader.releaseLock();
    decoder.decode();
  }

  if (finalResult) return finalResult;
  throw new Error('Gateway stream ended without a result payload.');
}

function createResponseParser(onEvent: (event: GatewayChatStreamEvent) => void): (
  line: string,
) => GatewayChatStreamEvent | null {
  return (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return null;

    let parsed: GatewayChatStreamEvent & {
      status?: string;
      result?: GatewayChatResult;
      toolsUsed?: unknown[];
    };
    try {
      parsed = JSON.parse(trimmed) as GatewayChatStreamEvent & {
        status?: string;
        result?: GatewayChatResult;
        toolsUsed?: unknown[];
      };
    } catch {
      return null;
    }

    if (!parsed || typeof parsed !== 'object') {
      return null;
    }

    if (
      parsed.type === 'result' &&
      parsed.result &&
      typeof (parsed.result as GatewayChatResult).status === 'string' &&
      Array.isArray((parsed.result as GatewayChatResult).toolsUsed)
    ) {
      return parsed as GatewayChatStreamResultEvent;
    }

    if (
      typeof parsed.status === 'string' &&
      parsed.status &&
      Array.isArray(parsed.toolsUsed)
    ) {
      return {
        type: 'result',
        result: parsed as unknown as GatewayChatResult,
      };
    }

    if (parsed.type === 'tool' && parsed.toolName && (parsed.phase === 'start' || parsed.phase === 'finish')) {
      const toolEvent = parsed as GatewayChatToolProgressEvent;
      onEvent(toolEvent);
      return null;
    }

    return null;
  };
}

export async function gatewayStatus(): Promise<GatewayStatus> {
  return requestJson<GatewayStatus>('/api/status', {
    method: 'GET',
    headers: authHeaders(),
  });
}

export async function gatewayHealth(): Promise<GatewayStatus> {
  return requestJson<GatewayStatus>('/health', { method: 'GET' });
}
