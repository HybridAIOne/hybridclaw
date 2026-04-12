import type {
  AppStatusResponse,
  BranchResponse,
  ChatCommandsResponse,
  ChatHistoryResponse,
  ChatRecentResponse,
  CommandResponse,
  MediaUploadResponse,
} from './chat-types';
import { requestJson } from './client';

export function fetchAppStatus(token: string): Promise<AppStatusResponse> {
  return requestJson<AppStatusResponse>('/api/status', { token });
}

export function fetchChatRecent(
  token: string,
  userId: string,
  channelId = 'web',
  limit = 10,
): Promise<ChatRecentResponse> {
  const params = new URLSearchParams({
    userId,
    channelId,
    limit: String(limit),
  });
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

export function fetchChatCommands(
  token: string,
  query?: string,
): Promise<ChatCommandsResponse> {
  const url = query
    ? `/api/chat/commands?q=${encodeURIComponent(query)}`
    : '/api/chat/commands';
  return requestJson<ChatCommandsResponse>(url, { token });
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
    body: {
      sessionId,
      guildId: null,
      channelId: 'web',
      userId,
      username: 'web',
      args,
    },
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

export function artifactUrl(path: string, token?: string): string {
  const params = new URLSearchParams({ path });
  if (token) params.set('token', token);
  return `/api/artifact?${params.toString()}`;
}
