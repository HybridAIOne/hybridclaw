import { GATEWAY_API_TOKEN, GATEWAY_BASE_URL } from './config.js';

export interface GatewayCommandResult {
  kind: 'plain' | 'info' | 'error';
  title?: string;
  text: string;
}

export interface GatewayChatResult {
  status: 'success' | 'error';
  result: string | null;
  toolsUsed: string[];
  error?: string;
}

export interface GatewayChatRequest {
  sessionId: string;
  guildId: string | null;
  channelId: string;
  userId: string;
  username: string | null;
  content: string;
  chatbotId?: string | null;
  model?: string | null;
  enableRag?: boolean;
}

export interface GatewayStatus {
  status: 'ok';
  uptime: number;
  sessions: number;
  activeContainers: number;
  defaultModel: string;
  ragDefault: boolean;
  timestamp: string;
}

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

export function renderGatewayCommand(result: GatewayCommandResult): string {
  if (!result.title) return result.text;
  return `${result.title}\n${result.text}`;
}

export async function gatewayCommand(params: {
  sessionId: string;
  guildId: string | null;
  channelId: string;
  args: string[];
}): Promise<GatewayCommandResult> {
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

export async function gatewayStatus(): Promise<GatewayStatus> {
  return requestJson<GatewayStatus>('/api/status', {
    method: 'GET',
    headers: authHeaders(),
  });
}
