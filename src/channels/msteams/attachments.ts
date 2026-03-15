import fs from 'node:fs/promises';
import os from 'node:os';
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
import type { ArtifactMetadata, MediaContextItem } from '../../types.js';

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
const PERSONAL_INLINE_IMAGE_MAX_DIMENSION = 4_096;
const MSTEAMS_MEDIA_TMP_PREFIX = 'hybridclaw-msteams-';
const REMOTE_MEDIA_FETCH_TIMEOUT_MS = 15_000;
const ACCESS_TOKEN_SCOPE_SUFFIX = '/.default';
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
const clientCredentialsTokenCache = new Map<
  string,
  { accessToken: string; expiresAt: number }
>();

interface OAuthTokenResponse {
  access_token?: string;
  expires_in?: number;
}

function normalizeValue(value: string | null | undefined): string {
  return String(value || '').trim();
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

function looksLikeSupportedAttachment(attachment: Attachment): boolean {
  const contentType = normalizeValue(attachment.contentType).toLowerCase();
  const name = normalizeValue(attachment.name).toLowerCase();
  return (
    contentType.startsWith('image/') ||
    contentType.startsWith('audio/') ||
    contentType === 'application/pdf' ||
    /\.(png|jpe?g|gif|webp|pdf|ogg|mp3|wav|m4a|docx|xlsx|pptx)$/i.test(name)
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

function extractAttachmentFilename(url: string, fallbackName: string): string {
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

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '_');
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

  if (!isAllowedHost(host, MSTEAMS_MEDIA_ALLOW_HOSTS)) {
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
  const cached = clientCredentialsTokenCache.get(scope);
  if (cached && now < cached.expiresAt - 60_000) {
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
  const response = await fetch(
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
  return accessToken;
}

async function fetchTeamsMediaResponse(url: string): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    REMOTE_MEDIA_FETCH_TIMEOUT_MS,
  );
  try {
    const response = await fetch(url, {
      headers: {
        Accept: '*/*',
      },
      signal: controller.signal,
    });
    if (response.ok || (response.status !== 401 && response.status !== 403)) {
      return response;
    }

    const host = new URL(url).hostname;
    if (!isAllowedHost(host, MSTEAMS_MEDIA_AUTH_ALLOW_HOSTS)) {
      return response;
    }

    for (const scopeBase of resolveScopeCandidatesForUrl(url)) {
      try {
        const accessToken = await acquireClientCredentialsToken(scopeBase);
        const retryResponse = await fetch(url, {
          headers: {
            Accept: '*/*',
            Authorization: `Bearer ${accessToken}`,
          },
          signal: controller.signal,
        });
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
  } finally {
    clearTimeout(timeout);
  }
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
}): Promise<string> {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), MSTEAMS_MEDIA_TMP_PREFIX),
  );
  const fileName = ensureFilenameWithExtension(
    params.filename,
    params.mimeType,
  );
  const filePath = path.join(directory, fileName);
  await fs.writeFile(filePath, params.buffer);
  return filePath;
}

async function buildMediaItem(params: {
  url: string;
  filename: string;
  mimeType?: string | null;
  sizeBytes?: number;
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
    const filePath = await stageInboundTeamsBuffer({
      buffer: decoded.buffer,
      filename: fallback.filename,
      mimeType: fallback.mimeType || decoded.mimeType,
    });
    return {
      ...fallback,
      path: filePath,
      mimeType: fallback.mimeType || decoded.mimeType,
      sizeBytes: decoded.buffer.length,
    };
  }

  try {
    const response = await fetchTeamsMediaResponse(fallback.url);
    if (!response.ok) {
      throw new Error(
        `Teams attachment fetch failed (${response.status} ${response.statusText})`,
      );
    }
    const contentLength = Number(response.headers.get('content-length') || 0);
    if (
      Number.isFinite(contentLength) &&
      contentLength > 0 &&
      contentLength > Math.max(1, MSTEAMS_MEDIA_MAX_MB) * 1024 * 1024
    ) {
      throw new Error('Teams attachment exceeds configured media limit.');
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    const resolvedMimeType =
      normalizeValue(response.headers.get('content-type'))
        .split(';')[0]
        .trim()
        .toLowerCase() || fallback.mimeType;
    const filePath = await stageInboundTeamsBuffer({
      buffer,
      filename: fallback.filename,
      mimeType: resolvedMimeType,
    });
    return {
      ...fallback,
      path: filePath,
      mimeType: resolvedMimeType || null,
      sizeBytes: buffer.length,
    };
  } catch (error) {
    logger.debug(
      { error, url: fallback.url, name: fallback.filename },
      'Failed to stage Teams attachment locally; using remote URL fallback',
    );
    return fallback;
  }
}

async function shouldInlinePersonalImageAttachment(params: {
  conversationType: string;
  contentType: string;
  sizeBytes: number;
  fileBuffer: Buffer;
  filename: string;
}): Promise<boolean> {
  const shouldInline =
    params.conversationType === 'personal' &&
    params.contentType.startsWith('image/') &&
    params.sizeBytes > 0 &&
    params.sizeBytes < PERSONAL_INLINE_IMAGE_MAX_BYTES;
  if (!shouldInline) {
    return false;
  }

  try {
    const { loadImage } = await import('@napi-rs/canvas');
    const image = await loadImage(params.fileBuffer);
    const width = Math.round(Number(image.width || 0));
    const height = Math.round(Number(image.height || 0));
    if (
      width > PERSONAL_INLINE_IMAGE_MAX_DIMENSION ||
      height > PERSONAL_INLINE_IMAGE_MAX_DIMENSION
    ) {
      logger.debug(
        { filename: params.filename, height, width },
        'Sending Teams personal image via uploaded attachment due to oversized dimensions',
      );
      return false;
    }
  } catch {
    // Fall back to inline delivery when image metadata cannot be inspected.
  }

  return true;
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
    await shouldInlinePersonalImageAttachment({
      conversationType,
      contentType,
      fileBuffer,
      filename,
      sizeBytes: fileBuffer.byteLength,
    })
  ) {
    return {
      name: filename,
      contentType,
      contentUrl: `data:${contentType};base64,${fileBuffer.toString('base64')}`,
    };
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
  const maxBytes = Math.max(1, MSTEAMS_MEDIA_MAX_MB) * 1024 * 1024;
  const media: MediaContextItem[] = [];

  for (const attachment of attachments) {
    const fallbackName = normalizeValue(attachment.name) || 'teams-attachment';
    const sizeBytes = Number(
      (attachment as { content?: { size?: number | string } }).content?.size ||
        0,
    );
    const normalizedSizeBytes = Number.isFinite(sizeBytes) ? sizeBytes : 0;
    const contentType = normalizeValue(attachment.contentType).toLowerCase();

    if (
      looksLikeSupportedAttachment(attachment) &&
      normalizeValue(attachment.contentUrl)
    ) {
      const mediaItem = await buildMediaItem({
        url: normalizeValue(attachment.contentUrl),
        filename: extractAttachmentFilename(
          normalizeValue(attachment.contentUrl),
          fallbackName,
        ),
        mimeType: inferMimeTypeFromFilename(fallbackName, contentType),
        sizeBytes: normalizedSizeBytes,
      });
      if (mediaItem && mediaItem.sizeBytes <= maxBytes) {
        media.push(mediaItem);
      }
    }

    if (contentType === TEAMS_FILE_DOWNLOAD_INFO_CONTENT_TYPE) {
      const content = (attachment as { content?: unknown }).content;
      if (content && typeof content === 'object' && !Array.isArray(content)) {
        const record = content as Record<string, unknown>;
        const downloadUrl =
          typeof record.downloadUrl === 'string' ? record.downloadUrl : '';
        const fileName =
          typeof record.fileName === 'string' && record.fileName.trim()
            ? record.fileName.trim()
            : fallbackName;
        const fileType =
          typeof record.fileType === 'string' ? record.fileType.trim() : '';
        const mediaItem = await buildMediaItem({
          url: downloadUrl,
          filename: fileName,
          mimeType:
            inferMimeTypeFromFilename(fileName, null) ||
            inferMimeTypeFromTeamsFileType(fileType),
          sizeBytes: normalizedSizeBytes,
        });
        if (mediaItem && mediaItem.sizeBytes <= maxBytes) {
          media.push(mediaItem);
        }
      }
    }

    if (contentType.startsWith('text/html')) {
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
  }

  return media;
}
