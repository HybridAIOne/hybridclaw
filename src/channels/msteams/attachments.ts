import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { TurnContext } from 'botbuilder-core';
import type { ConnectorClient } from 'botframework-connector';
import type { Activity, Attachment, AttachmentData } from 'botframework-schema';
import {
  MSTEAMS_APP_ID,
  MSTEAMS_APP_PASSWORD,
  MSTEAMS_MEDIA_ALLOW_HOSTS,
  MSTEAMS_MEDIA_AUTH_ALLOW_HOSTS,
  MSTEAMS_MEDIA_MAX_MB,
  MSTEAMS_TENANT_ID,
} from '../../config/config.js';
import { logger } from '../../logger.js';
import { createUploadedMediaContextItem } from '../../media/uploaded-media-cache.js';
import type { MediaContextItem } from '../../types/container.js';
import type { ArtifactMetadata } from '../../types/execution.js';
import { isRecord, normalizeValue } from './utils.js';

const OUTBOUND_MIME_TYPE_BY_EXTENSION: Record<string, string> = {
  '.gif': 'image/gif',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.pptx':
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.wav': 'audio/wav',
  '.webp': 'image/webp',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.docx':
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};
const HTML_IMAGE_SRC_RE = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi;
const TEAMS_FILE_DOWNLOAD_INFO_CONTENT_TYPE =
  'application/vnd.microsoft.teams.file.download.info';

const PERSONAL_INLINE_IMAGE_MAX_BYTES = 4 * 1024 * 1024;
const FILE_CONSENT_THRESHOLD_BYTES = 4 * 1024 * 1024;
const REMOTE_MEDIA_FETCH_TIMEOUT_MS = 15_000;
const ACCESS_TOKEN_SCOPE_SUFFIX = '/.default';
const ACCESS_TOKEN_CACHE_SKEW_MS = 60_000;
const PENDING_FILE_UPLOAD_TTL_MS = 30 * 60 * 1_000;
const REQUIRED_MSTEAMS_MEDIA_ALLOW_HOSTS = [
  '*.teams.microsoft.com',
  '*.trafficmanager.net',
  '*.blob.core.windows.net',
  'teams.microsoft.com',
  'teams.cdn.office.net',
  'statics.teams.cdn.office.net',
  'asm.skype.com',
  'ams.skype.com',
  'media.ams.skype.com',
];
const REQUIRED_MSTEAMS_MEDIA_AUTH_ALLOW_HOSTS = [
  '*.teams.microsoft.com',
  '*.trafficmanager.net',
  'api.botframework.com',
  'botframework.com',
  'teams.microsoft.com',
];
const OUTBOUND_EXTENSION_BY_MIME_TYPE: Record<string, string> = {
  'application/pdf': '.pdf',
  'audio/mp4': '.m4a',
  'audio/mpeg': '.mp3',
  'audio/ogg': '.ogg',
  'audio/wav': '.wav',
  'image/gif': '.gif',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};
const GENERIC_MIME_TYPES = new Set([
  'application/octet-stream',
  'binary/octet-stream',
]);
const clientCredentialsTokenCache = new Map<
  string,
  { accessToken: string; expiresAt: number }
>();
const pendingFileUploads = new Map<string, PendingTeamsFileUpload>();

interface OAuthTokenResponse {
  access_token?: string;
  expires_in?: number;
}

interface PendingTeamsFileUpload {
  buffer: Buffer;
  contentType: string;
  conversationId: string;
  createdAt: number;
  filename: string;
}

interface TeamsAttachmentDownloadInfo {
  url: string;
  filename: string;
  mimeType: string | null;
  sizeBytes: number;
  authToken: string | null;
}

interface ParsedFileConsentInvoke {
  action: 'accept' | 'decline';
  context: Record<string, unknown> | null;
  uploadInfo: Record<string, unknown> | null;
}

function matchesHostPattern(host: string, pattern: string): boolean {
  const normalizedHost = normalizeValue(host).toLowerCase();
  const normalizedPattern = normalizeValue(pattern).toLowerCase();
  if (!normalizedHost || !normalizedPattern) return false;
  if (normalizedPattern.startsWith('*.')) {
    const suffix = normalizedPattern.slice(1);
    return normalizedHost.endsWith(suffix);
  }
  return normalizedHost === normalizedPattern;
}

function isAllowedHost(host: string, patterns: string[]): boolean {
  return patterns.some((pattern) => matchesHostPattern(host, pattern));
}

function mergeHostPatterns(
  configuredPatterns: string[],
  requiredPatterns: string[],
): string[] {
  const merged = new Set<string>();
  for (const pattern of requiredPatterns) {
    const normalized = normalizeValue(pattern);
    if (normalized) merged.add(normalized);
  }
  for (const pattern of configuredPatterns) {
    const normalized = normalizeValue(pattern);
    if (normalized) merged.add(normalized);
  }
  return [...merged];
}

function getEffectiveMediaAllowHosts(): string[] {
  return mergeHostPatterns(
    MSTEAMS_MEDIA_ALLOW_HOSTS,
    REQUIRED_MSTEAMS_MEDIA_ALLOW_HOSTS,
  );
}

function getEffectiveMediaAuthAllowHosts(): string[] {
  return mergeHostPatterns(
    MSTEAMS_MEDIA_AUTH_ALLOW_HOSTS,
    REQUIRED_MSTEAMS_MEDIA_AUTH_ALLOW_HOSTS,
  );
}

function inferOutboundMimeType(
  filePath: string,
  preferredMimeType: string | null | undefined,
): string {
  const normalizedPreferred = normalizeValue(preferredMimeType);
  if (normalizedPreferred) return normalizedPreferred;
  const extension = path.extname(filePath).toLowerCase();
  return (
    OUTBOUND_MIME_TYPE_BY_EXTENSION[extension] || 'application/octet-stream'
  );
}

function inferMimeTypeFromFilename(
  filename: string,
  fallbackMimeType?: string | null,
): string | null {
  const normalizedFallback = normalizeValue(fallbackMimeType).toLowerCase();
  if (
    normalizedFallback &&
    !GENERIC_MIME_TYPES.has(normalizedFallback) &&
    !normalizedFallback.endsWith('/*') &&
    normalizedFallback !== TEAMS_FILE_DOWNLOAD_INFO_CONTENT_TYPE &&
    !normalizedFallback.startsWith('text/html')
  ) {
    return normalizedFallback;
  }
  const extension = path.extname(filename).toLowerCase();
  return OUTBOUND_MIME_TYPE_BY_EXTENSION[extension] || null;
}

function inferMimeTypeFromTeamsFileType(fileType: string): string | null {
  const normalized = normalizeValue(fileType).toLowerCase();
  if (!normalized) return null;
  return OUTBOUND_MIME_TYPE_BY_EXTENSION[`.${normalized}`] || null;
}

function sniffMimeTypeFromBuffer(buffer: Buffer): string | null {
  if (
    buffer.length >= 8 &&
    buffer
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'image/png';
  }
  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return 'image/jpeg';
  }
  if (
    buffer.length >= 6 &&
    (buffer.subarray(0, 6).toString('ascii') === 'GIF87a' ||
      buffer.subarray(0, 6).toString('ascii') === 'GIF89a')
  ) {
    return 'image/gif';
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  if (buffer.length >= 2 && buffer.subarray(0, 2).toString('ascii') === 'BM') {
    return 'image/bmp';
  }
  if (
    buffer.length >= 4 &&
    (buffer.subarray(0, 4).equals(Buffer.from([0x49, 0x49, 0x2a, 0x00])) ||
      buffer.subarray(0, 4).equals(Buffer.from([0x4d, 0x4d, 0x00, 0x2a])))
  ) {
    return 'image/tiff';
  }
  if (
    buffer.length >= 5 &&
    buffer.subarray(0, 5).toString('ascii') === '%PDF-'
  ) {
    return 'application/pdf';
  }
  return null;
}

function parseAttachmentHtmlContent(attachment: Attachment): string {
  const content = (attachment as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (!content || typeof content !== 'object' || Array.isArray(content)) {
    return '';
  }
  const record = content as Record<string, unknown>;
  const text =
    typeof record.text === 'string'
      ? record.text
      : typeof record.body === 'string'
        ? record.body
        : typeof record.content === 'string'
          ? record.content
          : '';
  return text;
}

function readAttachmentContentRecord(
  attachment: Attachment,
): Record<string, unknown> | null {
  const content = (attachment as { content?: unknown }).content;
  if (!content || typeof content !== 'object' || Array.isArray(content)) {
    return null;
  }
  return content as Record<string, unknown>;
}

function extractAttachmentFilename(url: string, fallbackName: string): string {
  if (normalizeValue(fallbackName) && fallbackName !== 'teams-attachment') {
    return fallbackName;
  }
  if (!url.startsWith('data:')) {
    try {
      const parsed = new URL(url);
      const name = parsed.pathname.split('/').pop()?.trim();
      if (name) return name;
    } catch {
      // Ignore malformed URLs and fall back to the provided name.
    }
  }
  return fallbackName;
}

function estimateDataUrlSize(url: string): number {
  const parts = url.split(',', 2);
  const payload = parts[1] || '';
  return payload ? Buffer.from(payload, 'base64').length : 0;
}

function shouldUseFileConsent(params: {
  conversationType: string;
  contentType: string;
  sizeBytes: number;
}): boolean {
  if (params.conversationType !== 'personal') {
    return false;
  }
  if (!params.contentType.startsWith('image/')) {
    return true;
  }
  return params.sizeBytes >= FILE_CONSENT_THRESHOLD_BYTES;
}

function storePendingFileUpload(entry: {
  buffer: Buffer;
  contentType: string;
  conversationId: string;
  filename: string;
}): string {
  const uploadId = randomUUID();
  pendingFileUploads.set(uploadId, {
    ...entry,
    createdAt: Date.now(),
  });
  return uploadId;
}

function getPendingFileUpload(uploadId: string): PendingTeamsFileUpload | null {
  const entry = pendingFileUploads.get(uploadId);
  if (!entry) {
    return null;
  }
  if (Date.now() - entry.createdAt > PENDING_FILE_UPLOAD_TTL_MS) {
    pendingFileUploads.delete(uploadId);
    return null;
  }
  return entry;
}

function evictExpiredClientCredentialsTokens(now: number): void {
  for (const [scope, entry] of clientCredentialsTokenCache.entries()) {
    if (now >= entry.expiresAt - ACCESS_TOKEN_CACHE_SKEW_MS) {
      clientCredentialsTokenCache.delete(scope);
    }
  }
}

function removePendingFileUpload(uploadId: string): void {
  pendingFileUploads.delete(uploadId);
}

function sanitizeFilename(name: string): string {
  const basename = path.basename(normalizeValue(name) || 'teams-attachment');
  const sanitized = basename
    .normalize('NFC')
    .replaceAll(/[<>:"/\\|?*]/g, '_')
    .split('')
    .filter((character) => {
      const codePoint = character.codePointAt(0);
      return (
        typeof codePoint === 'number' && codePoint >= 0x20 && codePoint !== 0x7f
      );
    })
    .join('')
    .trim();
  if (!sanitized || /^\.+$/.test(sanitized)) {
    return 'teams-attachment';
  }
  return sanitized;
}

function buildFileConsentCardAttachment(params: {
  filename: string;
  sizeInBytes: number;
  uploadId: string;
}): Attachment {
  return {
    contentType: 'application/vnd.microsoft.teams.card.file.consent',
    name: params.filename,
    content: {
      description: `File: ${params.filename}`,
      sizeInBytes: params.sizeInBytes,
      acceptContext: {
        filename: params.filename,
        uploadId: params.uploadId,
      },
      declineContext: {
        filename: params.filename,
        uploadId: params.uploadId,
      },
    },
  };
}

function buildFileInfoCardAttachment(params: {
  contentUrl: string;
  filename: string;
  fileType: string;
  uniqueId: string;
}): Attachment {
  return {
    contentType: 'application/vnd.microsoft.teams.card.file.info',
    contentUrl: params.contentUrl,
    name: params.filename,
    content: {
      uniqueId: params.uniqueId,
      fileType: params.fileType,
    },
  };
}

function fetchWithTimeout(
  input: string,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<Response> {
  return fetch(input, {
    ...init,
    signal: signal || AbortSignal.timeout(REMOTE_MEDIA_FETCH_TIMEOUT_MS),
  });
}

function getMaxInboundTeamsMediaBytes(): number {
  return Math.max(1, MSTEAMS_MEDIA_MAX_MB) * 1024 * 1024;
}

function ensureFilenameWithExtension(
  filename: string,
  mimeType: string | null,
): string {
  const safeName = sanitizeFilename(filename || 'teams-attachment');
  if (path.extname(safeName)) {
    return safeName;
  }
  const extension =
    mimeType && OUTBOUND_EXTENSION_BY_MIME_TYPE[mimeType.toLowerCase()]
      ? OUTBOUND_EXTENSION_BY_MIME_TYPE[mimeType.toLowerCase()]
      : '';
  return `${safeName}${extension}`;
}

function buildRemoteFallbackMediaItem(params: {
  url: string;
  filename: string;
  mimeType?: string | null;
  sizeBytes?: number;
}): MediaContextItem | null {
  const url = normalizeValue(params.url);
  if (!url) return null;

  if (url.startsWith('data:image/')) {
    return {
      path: null,
      url,
      originalUrl: url,
      mimeType: params.mimeType || null,
      sizeBytes:
        typeof params.sizeBytes === 'number' &&
        Number.isFinite(params.sizeBytes)
          ? params.sizeBytes
          : estimateDataUrlSize(url),
      filename: params.filename,
    };
  }

  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }

  const allowHosts = getEffectiveMediaAllowHosts();
  if (!isAllowedHost(host, allowHosts)) {
    logger.debug(
      { host, name: params.filename || null },
      'Skipping Teams attachment from non-allowlisted host',
    );
    return null;
  }

  const sizeBytes =
    typeof params.sizeBytes === 'number' && Number.isFinite(params.sizeBytes)
      ? params.sizeBytes
      : 0;
  return {
    path: null,
    url,
    originalUrl: url,
    mimeType: params.mimeType || null,
    sizeBytes,
    filename: params.filename,
  };
}

function resolveScopeCandidatesForUrl(url: string): string[] {
  try {
    const host = new URL(url).hostname.toLowerCase();
    const looksLikeGraph =
      host.endsWith('graph.microsoft.com') ||
      host.endsWith('sharepoint.com') ||
      host.endsWith('1drv.ms') ||
      host.includes('sharepoint');
    return looksLikeGraph
      ? ['https://graph.microsoft.com', 'https://api.botframework.com']
      : ['https://api.botframework.com', 'https://graph.microsoft.com'];
  } catch {
    return ['https://api.botframework.com', 'https://graph.microsoft.com'];
  }
}

async function acquireClientCredentialsToken(
  scopeBase: string,
): Promise<string> {
  const scope = `${scopeBase}${ACCESS_TOKEN_SCOPE_SUFFIX}`;
  const now = Date.now();
  evictExpiredClientCredentialsTokens(now);
  const cached = clientCredentialsTokenCache.get(scope);
  if (cached && now < cached.expiresAt - ACCESS_TOKEN_CACHE_SKEW_MS) {
    return cached.accessToken;
  }

  if (!MSTEAMS_APP_ID || !MSTEAMS_APP_PASSWORD || !MSTEAMS_TENANT_ID) {
    throw new Error(
      'Teams client credentials are unavailable for inbound media download.',
    );
  }

  const form = new URLSearchParams({
    client_id: MSTEAMS_APP_ID,
    client_secret: MSTEAMS_APP_PASSWORD,
    grant_type: 'client_credentials',
    scope,
  });
  const response = await fetchWithTimeout(
    `https://login.microsoftonline.com/${encodeURIComponent(
      MSTEAMS_TENANT_ID,
    )}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Teams token request failed (${response.status} ${response.statusText})`,
    );
  }
  const payload = (await response.json()) as OAuthTokenResponse;
  const accessToken = normalizeValue(payload.access_token);
  if (!accessToken) {
    throw new Error('Teams token response did not include access_token.');
  }
  const expiresIn = Math.max(60, Number(payload.expires_in || 3_600));
  clientCredentialsTokenCache.set(scope, {
    accessToken,
    expiresAt: now + expiresIn * 1_000,
  });
  evictExpiredClientCredentialsTokens(now);
  return accessToken;
}

async function fetchTeamsMediaResponse(
  url: string,
  authToken?: string | null,
): Promise<Response> {
  const requestSignal = AbortSignal.timeout(REMOTE_MEDIA_FETCH_TIMEOUT_MS);
  const normalizedAuthToken = normalizeValue(authToken);
  if (normalizedAuthToken) {
    const tokenResponse = await fetchWithTimeout(
      url,
      {
        headers: {
          Accept: '*/*',
          Authorization: `Bearer ${normalizedAuthToken}`,
        },
      },
      requestSignal,
    );
    if (
      tokenResponse.ok ||
      (tokenResponse.status !== 401 && tokenResponse.status !== 403)
    ) {
      return tokenResponse;
    }
  }

  const response = await fetchWithTimeout(
    url,
    {
      headers: {
        Accept: '*/*',
      },
    },
    requestSignal,
  );
  if (response.ok || (response.status !== 401 && response.status !== 403)) {
    return response;
  }

  const host = new URL(url).hostname;
  if (!isAllowedHost(host, getEffectiveMediaAuthAllowHosts())) {
    return response;
  }

  for (const scopeBase of resolveScopeCandidatesForUrl(url)) {
    try {
      const accessToken = await acquireClientCredentialsToken(scopeBase);
      const retryResponse = await fetchWithTimeout(
        url,
        {
          headers: {
            Accept: '*/*',
            Authorization: `Bearer ${accessToken}`,
          },
        },
        requestSignal,
      );
      if (
        retryResponse.ok ||
        (retryResponse.status !== 401 && retryResponse.status !== 403)
      ) {
        return retryResponse;
      }
    } catch {
      // Try the next scope.
    }
  }

  return response;
}

function decodeDataUrl(
  url: string,
): { buffer: Buffer; mimeType: string | null } | null {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/i.exec(url);
  if (!match || !match[2]) {
    return null;
  }
  try {
    return {
      buffer: Buffer.from(match[3] || '', 'base64'),
      mimeType: normalizeValue(match[1]).toLowerCase() || null,
    };
  } catch {
    return null;
  }
}

async function stageInboundTeamsBuffer(params: {
  buffer: Buffer;
  filename: string;
  mimeType: string | null;
  sizeBytes?: number;
  originalUrl?: string | null;
}): Promise<MediaContextItem> {
  if (params.buffer.length > getMaxInboundTeamsMediaBytes()) {
    throw new Error('Teams attachment exceeds configured media limit.');
  }
  const fileName = ensureFilenameWithExtension(
    params.filename,
    params.mimeType,
  );
  return await createUploadedMediaContextItem({
    attachmentName: fileName,
    buffer: params.buffer,
    mimeType: params.mimeType,
    sizeBytes: params.sizeBytes,
    originalUrl: params.originalUrl,
  });
}

async function buildMediaItem(params: {
  url: string;
  filename: string;
  mimeType?: string | null;
  sizeBytes?: number;
  authToken?: string | null;
}): Promise<MediaContextItem | null> {
  const fallback = buildRemoteFallbackMediaItem(params);
  if (!fallback) {
    return null;
  }

  if (fallback.url.startsWith('data:')) {
    const decoded = decodeDataUrl(fallback.url);
    if (!decoded) {
      return fallback;
    }
    if (decoded.buffer.length > getMaxInboundTeamsMediaBytes()) {
      logger.warn(
        {
          filename: fallback.filename,
          sizeBytes: decoded.buffer.length,
          maxBytes: getMaxInboundTeamsMediaBytes(),
        },
        'Skipping Teams data URL attachment that exceeds configured media limit',
      );
      return null;
    }
    const staged = await stageInboundTeamsBuffer({
      buffer: decoded.buffer,
      filename: fallback.filename,
      mimeType: fallback.mimeType || decoded.mimeType,
      sizeBytes: decoded.buffer.length,
      originalUrl: fallback.url,
    });
    return {
      ...staged,
      url: fallback.url,
      originalUrl: fallback.url,
      mimeType: fallback.mimeType || decoded.mimeType,
      sizeBytes: decoded.buffer.length,
      filename: fallback.filename,
    };
  }

  try {
    const response = await fetchTeamsMediaResponse(
      fallback.url,
      params.authToken,
    );
    if (!response.ok) {
      throw new Error(
        `Teams attachment fetch failed (${response.status} ${response.statusText})`,
      );
    }
    const contentLength = Number(response.headers.get('content-length') || 0);
    if (
      Number.isFinite(contentLength) &&
      contentLength > 0 &&
      contentLength > getMaxInboundTeamsMediaBytes()
    ) {
      throw new Error('Teams attachment exceeds configured media limit.');
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    const responseMimeType =
      normalizeValue(response.headers.get('content-type'))
        .split(';')[0]
        .trim()
        .toLowerCase() || null;
    const resolvedMimeType =
      (responseMimeType &&
      !GENERIC_MIME_TYPES.has(responseMimeType) &&
      !responseMimeType.endsWith('/*')
        ? responseMimeType
        : null) ||
      inferMimeTypeFromFilename(fallback.filename, fallback.mimeType) ||
      sniffMimeTypeFromBuffer(buffer) ||
      null;
    const staged = await stageInboundTeamsBuffer({
      buffer,
      filename: fallback.filename,
      mimeType: resolvedMimeType,
      sizeBytes: buffer.length,
      originalUrl: fallback.url,
    });
    return {
      ...staged,
      url: fallback.url,
      originalUrl: fallback.url,
      mimeType: resolvedMimeType || null,
      sizeBytes: buffer.length,
      filename: fallback.filename,
    };
  } catch (error) {
    logger.debug(
      { error, url: fallback.url, name: fallback.filename },
      'Failed to stage Teams attachment locally; using remote URL fallback',
    );
    return fallback;
  }
}

function extractAttachmentDownloadInfo(params: {
  attachment: Attachment;
  fallbackName: string;
  fallbackMimeType: string | null;
  sizeBytes: number;
}): TeamsAttachmentDownloadInfo | null {
  const record = readAttachmentContentRecord(params.attachment);
  if (!record) return null;

  const downloadUrl =
    typeof record.downloadUrl === 'string' ? record.downloadUrl.trim() : '';
  if (!downloadUrl) return null;

  const fileName =
    typeof record.fileName === 'string' && record.fileName.trim()
      ? record.fileName.trim()
      : typeof record.name === 'string' && record.name.trim()
        ? record.name.trim()
        : params.fallbackName;
  const fileType =
    typeof record.fileType === 'string' ? record.fileType.trim() : '';
  const authToken =
    typeof record.token === 'string' && record.token.trim()
      ? record.token.trim()
      : null;

  return {
    url: downloadUrl,
    filename: fileName,
    mimeType:
      inferMimeTypeFromFilename(fileName, params.fallbackMimeType) ||
      inferMimeTypeFromTeamsFileType(fileType),
    sizeBytes: params.sizeBytes,
    authToken,
  };
}

function extractAttachmentAuthToken(attachment: Attachment): string | null {
  const record = readAttachmentContentRecord(attachment);
  if (!record) return null;
  return typeof record.token === 'string' && record.token.trim()
    ? record.token.trim()
    : null;
}

function shouldInlinePersonalImageAttachment(params: {
  conversationType: string;
  contentType: string;
  sizeBytes: number;
}): boolean {
  return (
    params.conversationType === 'personal' &&
    params.contentType.startsWith('image/') &&
    params.sizeBytes > 0 &&
    params.sizeBytes < PERSONAL_INLINE_IMAGE_MAX_BYTES
  );
}

function requireConnectorClient(turnContext: TurnContext): ConnectorClient {
  const adapter = turnContext.adapter as { ConnectorClientKey?: symbol };
  const connectorKey = adapter.ConnectorClientKey;
  if (!connectorKey) {
    throw new Error('Teams connector client key is unavailable.');
  }
  const connectorClient =
    turnContext.turnState.get<ConnectorClient>(connectorKey);
  if (!connectorClient) {
    throw new Error('Teams connector client is unavailable.');
  }
  return connectorClient;
}

function parseFileConsentInvoke(
  activity: Partial<Activity>,
): ParsedFileConsentInvoke | null {
  if (activity.type !== 'invoke' || activity.name !== 'fileConsent/invoke') {
    return null;
  }
  const value = isRecord(activity.value) ? activity.value : null;
  if (!value || value.type !== 'fileUpload') {
    return null;
  }
  return {
    action: value.action === 'accept' ? 'accept' : 'decline',
    context: isRecord(value.context) ? value.context : null,
    uploadInfo: isRecord(value.uploadInfo) ? value.uploadInfo : null,
  };
}

async function uploadToConsentUrl(params: {
  buffer: Buffer;
  contentType: string;
  uploadUrl: string;
}): Promise<void> {
  const response = await fetchWithTimeout(params.uploadUrl, {
    method: 'PUT',
    headers: {
      'content-range': `bytes 0-${params.buffer.length - 1}/${params.buffer.length}`,
      'content-type': params.contentType || 'application/octet-stream',
    },
    body: new Uint8Array(params.buffer),
  });
  if (!response.ok) {
    throw new Error(
      `Teams consent upload failed (${response.status} ${response.statusText})`,
    );
  }
}

function buildUploadedAttachmentUrl(
  serviceUrl: string,
  attachmentId: string,
): string {
  const normalizedServiceUrl = serviceUrl.replace(/\/+$/g, '');
  return `${normalizedServiceUrl}/v3/attachments/${attachmentId}/views/original`;
}

export async function buildTeamsUploadedFileAttachment(params: {
  turnContext: TurnContext;
  filePath: string;
  filename?: string | null;
  mimeType?: string | null;
}): Promise<Attachment> {
  const conversationId = normalizeValue(
    params.turnContext.activity.conversation?.id,
  );
  if (!conversationId) {
    throw new Error(
      'Teams conversation id is unavailable for attachment upload.',
    );
  }

  const serviceUrl = normalizeValue(params.turnContext.activity.serviceUrl);
  if (!serviceUrl) {
    throw new Error('Teams serviceUrl is unavailable for attachment upload.');
  }

  const fileBuffer = await fs.readFile(params.filePath);
  const filename =
    normalizeValue(params.filename) ||
    path.basename(params.filePath) ||
    'teams-attachment';
  const contentType = inferOutboundMimeType(params.filePath, params.mimeType);
  const conversationType = normalizeValue(
    params.turnContext.activity.conversation?.conversationType,
  ).toLowerCase();
  if (
    shouldInlinePersonalImageAttachment({
      conversationType,
      contentType,
      sizeBytes: fileBuffer.byteLength,
    })
  ) {
    return {
      name: filename,
      contentType,
      contentUrl: `data:${contentType};base64,${fileBuffer.toString('base64')}`,
    };
  }

  if (
    shouldUseFileConsent({
      conversationType,
      contentType,
      sizeBytes: fileBuffer.byteLength,
    })
  ) {
    const uploadId = storePendingFileUpload({
      buffer: fileBuffer,
      contentType,
      conversationId,
      filename,
    });
    return buildFileConsentCardAttachment({
      filename,
      sizeInBytes: fileBuffer.byteLength,
      uploadId,
    });
  }

  if (fileBuffer.byteLength >= FILE_CONSENT_THRESHOLD_BYTES) {
    throw new Error(
      'Teams file uploads larger than 4 MB in channels or group chats require SharePoint/OneDrive fallback, which is not implemented yet.',
    );
  }

  const connectorClient = requireConnectorClient(params.turnContext);
  const uploadPayload: AttachmentData = {
    name: filename,
    originalBase64: new Uint8Array(fileBuffer),
    thumbnailBase64: new Uint8Array(),
    type: contentType,
  };
  const uploaded = await connectorClient.conversations.uploadAttachment(
    conversationId,
    uploadPayload,
  );
  const attachmentId = normalizeValue(uploaded.id);
  if (!attachmentId) {
    throw new Error('Teams attachment upload did not return an attachment id.');
  }

  return {
    name: filename,
    contentType,
    contentUrl: buildUploadedAttachmentUrl(serviceUrl, attachmentId),
  };
}

export async function maybeHandleMSTeamsFileConsentInvoke(
  turnContext: TurnContext,
): Promise<boolean> {
  const activity = turnContext.activity as Partial<Activity>;
  const consent = parseFileConsentInvoke(activity);
  if (!consent) {
    return false;
  }

  await turnContext.sendActivity({
    type: 'invokeResponse',
    value: { status: 200 },
  });

  const uploadId = normalizeValue(
    typeof consent.context?.uploadId === 'string'
      ? consent.context.uploadId
      : '',
  );
  const pendingUpload = uploadId ? getPendingFileUpload(uploadId) : null;
  const expiredMessage =
    'The Teams file upload request has expired. Please send the file again.';

  if (!pendingUpload) {
    if (consent.action === 'accept') {
      await turnContext.sendActivity(expiredMessage);
    }
    return true;
  }

  const invokeConversationId = normalizeValue(activity.conversation?.id);
  if (
    !invokeConversationId ||
    invokeConversationId !== pendingUpload.conversationId
  ) {
    if (consent.action === 'accept') {
      await turnContext.sendActivity(expiredMessage);
    }
    return true;
  }

  if (consent.action === 'decline') {
    removePendingFileUpload(uploadId);
    return true;
  }

  const uploadInfo = consent.uploadInfo;
  const uploadUrl = normalizeValue(
    uploadInfo && typeof uploadInfo.uploadUrl === 'string'
      ? uploadInfo.uploadUrl
      : '',
  );
  const contentUrl = normalizeValue(
    uploadInfo && typeof uploadInfo.contentUrl === 'string'
      ? uploadInfo.contentUrl
      : '',
  );
  const uniqueId = normalizeValue(
    uploadInfo && typeof uploadInfo.uniqueId === 'string'
      ? uploadInfo.uniqueId
      : '',
  );
  const fileType = normalizeValue(
    uploadInfo && typeof uploadInfo.fileType === 'string'
      ? uploadInfo.fileType
      : path.extname(pendingUpload.filename).replace(/^\./, ''),
  );
  const uploadedName = normalizeValue(
    uploadInfo && typeof uploadInfo.name === 'string'
      ? uploadInfo.name
      : pendingUpload.filename,
  );

  if (!uploadUrl || !contentUrl || !uniqueId) {
    removePendingFileUpload(uploadId);
    await turnContext.sendActivity(expiredMessage);
    return true;
  }

  try {
    await uploadToConsentUrl({
      buffer: pendingUpload.buffer,
      contentType: pendingUpload.contentType,
      uploadUrl,
    });
    await turnContext.sendActivity({
      type: 'message',
      attachments: [
        buildFileInfoCardAttachment({
          contentUrl,
          filename: uploadedName || pendingUpload.filename,
          fileType:
            fileType || path.extname(pendingUpload.filename).replace(/^\./, ''),
          uniqueId,
        }),
      ],
    });
  } catch (error) {
    logger.warn(
      { error, uploadId, filename: pendingUpload.filename },
      'Teams file consent upload failed',
    );
    await turnContext.sendActivity(
      `Teams file upload failed for ${pendingUpload.filename}. Please retry the send.`,
    );
  } finally {
    removePendingFileUpload(uploadId);
  }

  return true;
}

export async function buildTeamsArtifactAttachments(params: {
  turnContext: TurnContext;
  artifacts?: ArtifactMetadata[];
}): Promise<Attachment[]> {
  const artifacts = Array.isArray(params.artifacts) ? params.artifacts : [];
  const attachments: Attachment[] = [];
  for (const artifact of artifacts) {
    attachments.push(
      await buildTeamsUploadedFileAttachment({
        turnContext: params.turnContext,
        filePath: artifact.path,
        filename: artifact.filename,
        mimeType: artifact.mimeType,
      }),
    );
  }
  return attachments;
}

export async function buildTeamsAttachmentContext(params: {
  activity: Partial<Activity>;
}): Promise<MediaContextItem[]> {
  const attachments = Array.isArray(params.activity.attachments)
    ? params.activity.attachments
    : [];
  const maxBytes = getMaxInboundTeamsMediaBytes();
  const media: MediaContextItem[] = [];
  const htmlAttachments: Attachment[] = [];

  for (const attachment of attachments) {
    const fallbackName = normalizeValue(attachment.name) || 'teams-attachment';
    const sizeBytes = Number(
      (attachment as { content?: { size?: number | string } }).content?.size ||
        0,
    );
    const normalizedSizeBytes = Number.isFinite(sizeBytes) ? sizeBytes : 0;
    const contentType = normalizeValue(attachment.contentType).toLowerCase();

    if (contentType.startsWith('text/html')) {
      htmlAttachments.push(attachment);
      continue;
    }

    const downloadInfo = extractAttachmentDownloadInfo({
      attachment,
      fallbackName,
      fallbackMimeType: contentType,
      sizeBytes: normalizedSizeBytes,
    });
    if (downloadInfo) {
      const mediaItem = await buildMediaItem({
        url: downloadInfo.url,
        filename: downloadInfo.filename,
        mimeType: downloadInfo.mimeType,
        sizeBytes: downloadInfo.sizeBytes,
        authToken: downloadInfo.authToken,
      });
      if (mediaItem && mediaItem.sizeBytes <= maxBytes) {
        media.push(mediaItem);
        continue;
      }
    }

    if (normalizeValue(attachment.contentUrl)) {
      const attachmentUrl = normalizeValue(attachment.contentUrl);
      const mediaItem = await buildMediaItem({
        url: attachmentUrl,
        filename: extractAttachmentFilename(attachmentUrl, fallbackName),
        mimeType: inferMimeTypeFromFilename(fallbackName, contentType),
        sizeBytes: normalizedSizeBytes,
        authToken: extractAttachmentAuthToken(attachment),
      });
      if (mediaItem && mediaItem.sizeBytes <= maxBytes) {
        media.push(mediaItem);
      }
    }
  }

  if (media.length > 0) {
    return media;
  }

  for (const attachment of htmlAttachments) {
    const fallbackName = normalizeValue(attachment.name) || 'teams-attachment';
    const html = parseAttachmentHtmlContent(attachment);
    HTML_IMAGE_SRC_RE.lastIndex = 0;
    let match = HTML_IMAGE_SRC_RE.exec(html);
    while (match) {
      const src = normalizeValue(match[1]);
      if (src && !src.startsWith('cid:')) {
        const filename = extractAttachmentFilename(src, fallbackName);
        const mediaItem = await buildMediaItem({
          url: src,
          filename,
          mimeType: inferMimeTypeFromFilename(filename, 'image/png'),
          sizeBytes: 0,
        });
        if (mediaItem && mediaItem.sizeBytes <= maxBytes) {
          media.push(mediaItem);
        }
      }
      match = HTML_IMAGE_SRC_RE.exec(html);
    }
  }

  return media;
}
