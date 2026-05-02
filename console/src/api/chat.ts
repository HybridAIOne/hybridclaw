import type {
  BranchResponse,
  ChatCommandsResponse,
  ChatContextResponse,
  ChatHistoryResponse,
  ChatMobileQrResponse,
  ChatRecentResponse,
  CommandResponse,
  MediaUploadResponse,
} from './chat-types';
import {
  buildWebCommandRequestBody,
  dispatchAuthRequired,
  requestHeaders,
  requestJson,
  validateToken,
} from './client';

export { validateToken as fetchAppStatus };

export function fetchChatRecent(
  token: string,
  userId: string,
  channelId = 'web',
  limit = 10,
  query?: string,
): Promise<ChatRecentResponse> {
  const params = new URLSearchParams({
    userId,
    channelId,
    limit: String(limit),
  });
  if (query) params.set('q', query);
  return requestJson<ChatRecentResponse>(
    `/api/chat/recent?${params.toString()}`,
    { token },
  );
}

export function fetchChatHistory(
  token: string,
  sessionId: string,
  limit = 80,
): Promise<ChatHistoryResponse> {
  const params = new URLSearchParams({
    sessionId,
    limit: String(limit),
  });
  return requestJson<ChatHistoryResponse>(`/api/history?${params.toString()}`, {
    token,
  });
}

export function fetchChatContext(
  token: string,
  sessionId: string,
): Promise<ChatContextResponse> {
  const params = new URLSearchParams({ sessionId });
  return requestJson<ChatContextResponse>(
    `/api/chat/context?${params.toString()}`,
    { token },
  );
}

export function fetchChatCommands(
  token: string,
  query?: string,
): Promise<ChatCommandsResponse> {
  const url = query
    ? `/api/chat/commands?q=${encodeURIComponent(query)}`
    : '/api/chat/commands';
  return requestJson<ChatCommandsResponse>(url, { token });
}

export function createChatMobileQr(
  token: string,
  payload: { userId: string; sessionId: string; baseUrl?: string },
): Promise<ChatMobileQrResponse> {
  return requestJson<ChatMobileQrResponse>('/api/chat/mobile-qr', {
    token,
    method: 'POST',
    body: payload,
  });
}

export function createChatBranch(
  token: string,
  sessionId: string,
  beforeMessageId: number | string,
): Promise<BranchResponse> {
  return requestJson<BranchResponse>('/api/chat/branch', {
    token,
    method: 'POST',
    body: { sessionId, beforeMessageId },
  });
}

export function executeCommand(
  token: string,
  sessionId: string,
  userId: string,
  args: string[],
): Promise<CommandResponse> {
  return requestJson<CommandResponse>('/api/command', {
    token,
    method: 'POST',
    body: buildWebCommandRequestBody({
      sessionId,
      args,
      userId,
      username: 'web',
    }),
  });
}

export function uploadMedia(
  token: string,
  file: File,
): Promise<MediaUploadResponse> {
  return requestJson<MediaUploadResponse>('/api/media/upload', {
    token,
    method: 'POST',
    rawBody: file,
    extraHeaders: {
      'Content-Type': file.type || 'application/octet-stream',
      'X-Hybridclaw-Filename': encodeURIComponent(file.name || 'upload'),
    },
  });
}

export function artifactUrl(path: string): string {
  const params = new URLSearchParams({ path });
  return `/api/artifact?${params.toString()}`;
}

export function agentAvatarUrl(imageUrl: string): string {
  return imageUrl;
}

async function fetchAuthenticatedBlob(
  token: string,
  url: string,
): Promise<Blob> {
  const response = await fetch(url, {
    headers: requestHeaders(token),
    cache: 'no-store',
  });

  if (!response.ok) {
    const contentType = (response.headers.get('content-type') || '')
      .toLowerCase()
      .trim();
    let message = `${response.status} ${response.statusText}`;

    if (contentType.includes('application/json')) {
      const payload = (await response.json().catch(() => null)) as {
        error?: string;
        text?: string;
      } | null;
      message = payload?.error || payload?.text || message;
    } else {
      const text = (await response.text().catch(() => '')).trim();
      if (text) message = text;
    }

    if (response.status === 401) {
      dispatchAuthRequired(message);
    }
    throw new Error(message);
  }

  return response.blob();
}

export async function fetchArtifactBlob(
  token: string,
  artifactPath: string,
): Promise<Blob> {
  return fetchAuthenticatedBlob(token, artifactUrl(artifactPath));
}

export function fetchAgentAvatarBlob(
  token: string,
  imageUrl: string,
): Promise<Blob> {
  return fetchAuthenticatedBlob(token, agentAvatarUrl(imageUrl));
}
