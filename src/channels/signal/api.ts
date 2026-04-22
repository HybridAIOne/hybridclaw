import { randomUUID } from 'node:crypto';

export interface SignalSourceInfo {
  number?: string;
  uuid?: string;
  name?: string;
}

export interface SignalGroupInfo {
  groupId: string;
  groupName?: string;
}

export interface SignalDataMessage {
  timestamp: number;
  message?: string | null;
  groupInfo?: SignalGroupInfo | null;
  mentions?: Array<{ name?: string; number?: string; uuid?: string }>;
}

export interface SignalEnvelope {
  source: string;
  sourceNumber?: string;
  sourceUuid?: string;
  sourceName?: string;
  sourceDevice?: number;
  timestamp: number;
  dataMessage?: SignalDataMessage | null;
}

export interface SignalReceiveEvent {
  account: string;
  envelope: SignalEnvelope;
}

interface SignalRpcResponse<T> {
  jsonrpc?: string;
  id?: string | number | null;
  result?: T;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
}

export class SignalRpcError extends Error {
  constructor(
    public readonly method: string,
    public readonly statusCode: number,
    public readonly errorCode: number | null,
    public readonly description: string,
  ) {
    super(
      `Signal RPC ${method} failed (${statusCode}${errorCode ? `/${errorCode}` : ''}): ${description}`,
    );
    this.name = 'SignalRpcError';
  }
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}

export function normalizeSignalDaemonUrl(value: string): string {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    throw new Error('Signal daemon URL is required');
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return trimTrailingSlashes(trimmed);
  }
  return trimTrailingSlashes(`http://${trimmed}`);
}

export async function callSignalRpc<T>(
  daemonUrl: string,
  method: string,
  params?: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  const baseUrl = normalizeSignalDaemonUrl(daemonUrl);
  const id = randomUUID();
  const body = JSON.stringify({ jsonrpc: '2.0', method, params, id });
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/api/v1/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Signal transport error';
    throw new SignalRpcError(method, 0, null, message);
  }

  if (response.status === 201) {
    return undefined as T;
  }

  const text = await response.text().catch(() => '');
  if (!response.ok && !text) {
    throw new SignalRpcError(
      method,
      response.status,
      null,
      `Signal RPC empty response`,
    );
  }

  let parsed: SignalRpcResponse<T> | null = null;
  if (text) {
    try {
      parsed = JSON.parse(text) as SignalRpcResponse<T>;
    } catch {
      parsed = null;
    }
  }

  if (parsed?.error) {
    throw new SignalRpcError(
      method,
      response.status,
      typeof parsed.error.code === 'number' ? parsed.error.code : null,
      parsed.error.message?.trim() || 'Signal RPC error',
    );
  }
  if (!response.ok || !parsed || !Object.hasOwn(parsed, 'result')) {
    throw new SignalRpcError(
      method,
      response.status,
      null,
      text.slice(0, 300) || 'Invalid Signal RPC envelope',
    );
  }
  return parsed.result as T;
}

export interface SignalSseSubscription {
  abort: () => void;
  done: Promise<void>;
}

export function streamSignalEvents(params: {
  daemonUrl: string;
  account?: string;
  onEvent: (event: SignalReceiveEvent) => void;
  onError?: (error: unknown) => void;
}): SignalSseSubscription {
  const controller = new AbortController();
  const baseUrl = normalizeSignalDaemonUrl(params.daemonUrl);
  const url = new URL(`${baseUrl}/api/v1/events`);
  if (params.account) {
    url.searchParams.set('account', params.account);
  }

  const done = (async () => {
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: { Accept: 'text/event-stream' },
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      params.onError?.(error);
      return;
    }
    if (!response.ok || !response.body) {
      params.onError?.(
        new SignalRpcError(
          'events',
          response.status,
          null,
          response.statusText || 'SSE failed',
        ),
      );
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let currentData = '';
    let currentEvent = '';

    const flushEvent = (): void => {
      if (!currentData) {
        currentEvent = '';
        return;
      }
      const data = currentData;
      currentData = '';
      const eventName = currentEvent;
      currentEvent = '';
      if (eventName && eventName !== 'receive' && eventName !== 'message') {
        return;
      }
      try {
        const parsed = JSON.parse(data) as SignalReceiveEvent;
        if (parsed?.envelope) {
          params.onEvent(parsed);
        }
      } catch (error) {
        params.onError?.(error);
      }
    };

    try {
      while (true) {
        const { value, done: streamDone } = await reader.read();
        if (streamDone) break;
        buffer += decoder.decode(value, { stream: true });
        let newlineIndex = buffer.indexOf('\n');
        while (newlineIndex !== -1) {
          let line = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);
          if (line.endsWith('\r')) line = line.slice(0, -1);

          if (line === '') {
            flushEvent();
          } else if (!line.startsWith(':')) {
            const colonIndex = line.indexOf(':');
            const field =
              colonIndex === -1 ? line : line.slice(0, colonIndex).trim();
            let raw = colonIndex === -1 ? '' : line.slice(colonIndex + 1);
            if (raw.startsWith(' ')) raw = raw.slice(1);
            if (field === 'event') {
              currentEvent = raw;
            } else if (field === 'data') {
              currentData = currentData ? `${currentData}\n${raw}` : raw;
            }
          }
          newlineIndex = buffer.indexOf('\n');
        }
      }
      flushEvent();
    } catch (error) {
      if (!controller.signal.aborted) {
        params.onError?.(error);
      }
    }
  })();

  return {
    abort: () => controller.abort(),
    done,
  };
}
