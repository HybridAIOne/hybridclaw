import fs from 'node:fs/promises';

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  username?: string;
  first_name?: string;
  last_name?: string;
}

export interface TelegramChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

export interface TelegramMessageEntity {
  type: string;
  offset: number;
  length: number;
  user?: TelegramUser;
}

export interface TelegramPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TelegramDocument {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramAudio {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramVoice {
  file_id: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramVideo {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  caption?: string;
  entities?: TelegramMessageEntity[];
  caption_entities?: TelegramMessageEntity[];
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
  audio?: TelegramAudio;
  voice?: TelegramVoice;
  video?: TelegramVideo;
  reply_to_message?: TelegramMessage;
  message_thread_id?: number;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  channel_post?: TelegramMessage;
}

export interface TelegramFile {
  file_id: string;
  file_unique_id?: string;
  file_size?: number;
  file_path?: string;
}

interface TelegramApiEnvelope<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

export class TelegramApiError extends Error {
  constructor(
    public readonly method: string,
    public readonly statusCode: number,
    public readonly errorCode: number | null,
    public readonly description: string,
  ) {
    super(
      `Telegram API ${method} failed (${statusCode}${errorCode ? `/${errorCode}` : ''}): ${description}`,
    );
    this.name = 'TelegramApiError';
  }
}

function buildTelegramApiUrl(token: string, method: string): string {
  return `https://api.telegram.org/bot${token}/${method}`;
}

function buildTelegramFileUrl(token: string, filePath: string): string {
  return `https://api.telegram.org/file/bot${token}/${filePath.replace(/^\/+/, '')}`;
}

async function parseTelegramEnvelope<T>(
  response: Response,
  method: string,
): Promise<T> {
  let payload: TelegramApiEnvelope<T> | null = null;
  try {
    payload = (await response.json()) as TelegramApiEnvelope<T>;
  } catch {
    payload = null;
  }

  if (!response.ok || !payload?.ok || payload.result == null) {
    const description =
      payload?.description?.trim() ||
      (await response.text().catch(() => '')).trim() ||
      'Unknown Telegram API error';
    throw new TelegramApiError(
      method,
      response.status,
      typeof payload?.error_code === 'number' ? payload.error_code : null,
      description,
    );
  }

  return payload.result;
}

export async function callTelegramApi<T>(
  token: string,
  method: string,
  body?: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(buildTelegramApiUrl(token, method), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
  return await parseTelegramEnvelope<T>(response, method);
}

export async function callTelegramMultipartApi<T>(
  token: string,
  method: string,
  formData: FormData,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(buildTelegramApiUrl(token, method), {
    method: 'POST',
    body: formData,
    signal,
  });
  return await parseTelegramEnvelope<T>(response, method);
}

export async function fetchTelegramFile(
  token: string,
  filePath: string,
  signal?: AbortSignal,
): Promise<Buffer> {
  const response = await fetch(buildTelegramFileUrl(token, filePath), {
    method: 'GET',
    signal,
  });
  if (!response.ok) {
    const description = (await response.text().catch(() => '')).trim();
    throw new TelegramApiError(
      'downloadFile',
      response.status,
      null,
      description || 'Telegram file download failed',
    );
  }
  return Buffer.from(await response.arrayBuffer());
}

export async function createTelegramUploadForm(params: {
  chatId: string;
  fileField: 'audio' | 'document' | 'photo' | 'video';
  filePath: string;
  filename: string;
  mimeType?: string | null;
  topicId?: number;
  replyToMessageId?: number;
  caption?: string;
  disableNotification?: boolean;
}): Promise<FormData> {
  const formData = new FormData();
  formData.set('chat_id', params.chatId);
  if (params.topicId) {
    formData.set('message_thread_id', String(params.topicId));
  }
  if (params.replyToMessageId) {
    formData.set('reply_to_message_id', String(params.replyToMessageId));
  }
  if (params.caption?.trim()) {
    formData.set('caption', params.caption);
  }
  if (params.disableNotification) {
    formData.set('disable_notification', 'true');
  }

  const buffer = await fs.readFile(params.filePath);
  const blob = new Blob([buffer], {
    type: params.mimeType || 'application/octet-stream',
  });
  formData.set(params.fileField, blob, params.filename);
  return formData;
}
