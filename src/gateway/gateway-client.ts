import type { SkillConfigChannelKind } from '../channels/channel.js';
import { GATEWAY_API_TOKEN, GATEWAY_BASE_URL } from '../config/config.js';
import {
  type GatewayAdminSkillsResponse,
  type GatewayChatApprovalEvent,
  type GatewayChatRequestBody,
  type GatewayChatResult,
  type GatewayChatStreamEvent,
  type GatewayChatStreamResultEvent,
  type GatewayChatTextDeltaEvent,
  type GatewayChatThinkingDeltaEvent,
  type GatewayChatToolProgressEvent,
  type GatewayCommandRequest,
  type GatewayCommandResult,
  type GatewayHistoryResponse,
  type GatewayMediaItem,
  type GatewayMediaUploadResult,
  type GatewayPluginCommandSummary,
  type GatewayProactiveMessage,
  type GatewayProactivePullResponse,
  type GatewayStatus,
  renderGatewayCommand,
} from './gateway-types.js';

export type {
  GatewayAdminSkillsResponse,
  GatewayChatApprovalEvent,
  GatewayChatResult,
  GatewayChatStreamEvent,
  GatewayCommandResult,
  GatewayHistoryResponse,
  GatewayMediaItem,
  GatewayMediaUploadResult,
  GatewayPluginCommandSummary,
  GatewayProactiveMessage,
  GatewayProactivePullResponse,
  GatewayStatus,
};
export { renderGatewayCommand };
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
    const message =
      typeof payload.text === 'string' && payload.text.trim()
        ? payload.text
        : typeof payload.error === 'string'
          ? payload.error
          : `${response.status} ${response.statusText}`;
    throw new Error(`Gateway error: ${message}`);
  }
  return payload as T;
}

export async function gatewayCommand(
  params: GatewayCommandRequest,
): Promise<GatewayCommandResult> {
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

export async function gatewayUploadMedia(params: {
  filename: string;
  body: ArrayBuffer | Blob | Buffer;
  mimeType?: string | null;
  signal?: AbortSignal;
}): Promise<GatewayMediaUploadResult> {
  const body =
    params.body instanceof Blob || params.body instanceof ArrayBuffer
      ? params.body
      : new Uint8Array(params.body);
  return requestJson<GatewayMediaUploadResult>('/api/media/upload', {
    method: 'POST',
    headers: {
      'Content-Type':
        String(params.mimeType || '').trim() || 'application/octet-stream',
      'X-Hybridclaw-Filename': encodeURIComponent(params.filename),
      ...authHeaders(),
    },
    body,
    signal: params.signal,
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
    const errorText =
      (await response.text().catch(() => '')).trim() ||
      `${response.status} ${response.statusText}`;
    throw new Error(`Gateway error: ${errorText}`);
  }

  const parser = createResponseParser(onEvent);
  if (!response.body) {
    const text =
      (await response.text().catch(() => '')).trim() ||
      `${response.status} ${response.statusText}`;
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

function createResponseParser(
  onEvent: (event: GatewayChatStreamEvent) => void,
): (line: string) => GatewayChatStreamEvent | null {
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

    if (
      parsed.type === 'tool' &&
      parsed.toolName &&
      (parsed.phase === 'start' || parsed.phase === 'finish')
    ) {
      const toolEvent = parsed as GatewayChatToolProgressEvent;
      onEvent(toolEvent);
      return null;
    }

    if (parsed.type === 'text' && typeof parsed.delta === 'string') {
      const textEvent = parsed as GatewayChatTextDeltaEvent;
      onEvent(textEvent);
      return null;
    }

    if (parsed.type === 'thinking' && typeof parsed.delta === 'string') {
      const thinkingEvent = parsed as GatewayChatThinkingDeltaEvent;
      onEvent(thinkingEvent);
      return null;
    }

    if (
      parsed.type === 'approval' &&
      typeof parsed.approvalId === 'string' &&
      typeof parsed.prompt === 'string'
    ) {
      const approvalEvent = parsed as GatewayChatApprovalEvent;
      onEvent(approvalEvent);
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

export async function fetchGatewayAdminSkills(): Promise<GatewayAdminSkillsResponse> {
  return requestJson<GatewayAdminSkillsResponse>('/api/admin/skills', {
    method: 'GET',
    headers: authHeaders(),
  });
}

export async function saveGatewayAdminSkillEnabled(params: {
  name: string;
  enabled: boolean;
  channel?: SkillConfigChannelKind;
}): Promise<GatewayAdminSkillsResponse> {
  return requestJson<GatewayAdminSkillsResponse>('/api/admin/skills', {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
    },
    body: JSON.stringify(params),
  });
}

export async function gatewayPullProactive(
  channelId: string,
  limit = 20,
): Promise<GatewayProactivePullResponse> {
  const params = new URLSearchParams({
    channelId,
    limit: String(Math.max(1, Math.floor(limit))),
  });
  return requestJson<GatewayProactivePullResponse>(
    `/api/proactive/pull?${params.toString()}`,
    {
      method: 'GET',
      headers: authHeaders(),
    },
  );
}

export async function gatewayHistory(
  sessionId: string,
  limit = 100,
  options?: {
    summarySinceMs?: number | null;
  },
): Promise<GatewayHistoryResponse> {
  const params = new URLSearchParams({
    sessionId,
    limit: String(Math.max(1, Math.floor(limit))),
  });
  if (
    typeof options?.summarySinceMs === 'number' &&
    Number.isFinite(options.summarySinceMs) &&
    options.summarySinceMs > 0
  ) {
    params.set('summarySinceMs', String(Math.floor(options.summarySinceMs)));
  }
  return requestJson<GatewayHistoryResponse>(
    `/api/history?${params.toString()}`,
    {
      method: 'GET',
      headers: authHeaders(),
    },
  );
}

export async function gatewayShutdown(): Promise<{
  status: string;
  message?: string;
}> {
  return requestJson<{ status: string; message?: string }>(
    '/api/admin/shutdown',
    {
      method: 'POST',
      headers: authHeaders(),
    },
  );
}
