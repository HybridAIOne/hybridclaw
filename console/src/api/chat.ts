import type {
  BranchResponse,
  ChatCleanupResponse,
  ChatCommandsResponse,
  ChatContextResponse,
  ChatHistoryResponse,
  ChatMobileQrResponse,
  ChatRecentResponse,
  DictationTranscriptionResponse,
  MediaCapabilitiesResponse,
  MediaUploadResponse,
  RateResponseRequest,
  RateResponseResponse,
} from './chat-types';
import {
  buildWebCommandRequestBody,
  requestHeaders,
  requestJson,
  throwResponseError,
  validateToken,
} from './client';
import type { AdminCommandResult } from './types';

export { validateToken as fetchAppStatus };

export function fetchChatRecent(
  token: string,
  userId: string,
  channelId = 'web',
  limit = 10,
  query?: string,
  scope?: 'user' | 'all',
): Promise<ChatRecentResponse> {
  const params = new URLSearchParams({
    userId,
    channelId,
    limit: String(limit),
  });
  if (query) params.set('q', query);
  if (scope) params.set('scope', scope);
  return requestJson<ChatRecentResponse>(
    `/api/chat/recent?${params.toString()}`,
    { token },
  );
}

export function cleanupNoUserChatSessions(
  token: string,
  params: {
    channelId?: string;
    keepSessionId?: string;
  },
): Promise<ChatCleanupResponse> {
  const query = new URLSearchParams({
    channelId: params.channelId || 'web',
  });
  if (params.keepSessionId) {
    query.set('keepSessionId', params.keepSessionId);
  }
  return requestJson<ChatCleanupResponse>(
    `/api/chat/cleanup?${query.toString()}`,
    { token, method: 'POST' },
  );
}

export function fetchChatHistory(
  token: string,
  sessionId: string,
  limit = 80,
  userId?: string,
  agentId?: string,
): Promise<ChatHistoryResponse> {
  const params = new URLSearchParams({
    sessionId,
    limit: String(limit),
  });
  if (userId) params.set('userId', userId);
  if (agentId?.trim()) params.set('agentId', agentId.trim());
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

export function rateChatResponse(
  token: string,
  payload: RateResponseRequest,
): Promise<RateResponseResponse> {
  return requestJson<RateResponseResponse>('/api/chat/rating', {
    token,
    method: 'POST',
    body: payload,
  });
}

export function executeCommand(
  token: string,
  sessionId: string,
  userId: string,
  args: string[],
): Promise<AdminCommandResult> {
  return requestJson<AdminCommandResult>('/api/command', {
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

export function transcribeDictation(
  token: string,
  recording: Blob,
  signal?: AbortSignal,
): Promise<DictationTranscriptionResponse> {
  return requestJson<DictationTranscriptionResponse>('/api/media/transcribe', {
    token,
    method: 'POST',
    rawBody: recording,
    extraHeaders: {
      'Content-Type': recording.type || 'audio/webm',
    },
    signal,
  });
}

export function fetchMediaCapabilities(
  token: string,
): Promise<MediaCapabilitiesResponse> {
  return requestJson<MediaCapabilitiesResponse>('/api/media/capabilities', {
    token,
  });
}

export async function synthesizeSpeech(
  token: string,
  text: string,
  signal?: AbortSignal,
): Promise<Blob> {
  const response = await fetch('/api/media/speech', {
    method: 'POST',
    headers: requestHeaders(token, { text }),
    body: JSON.stringify({ text }),
    signal,
  });
  if (!response.ok) await throwResponseError(response);
  return response.blob();
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
    await throwResponseError(response);
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
