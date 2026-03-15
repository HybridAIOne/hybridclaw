import fs from 'node:fs/promises';
import path from 'node:path';
import type { TurnContext } from 'botbuilder-core';
import type { ConnectorClient } from 'botframework-connector';
import type { Activity, Attachment, AttachmentData } from 'botframework-schema';
import {
  MSTEAMS_MEDIA_ALLOW_HOSTS,
  MSTEAMS_MEDIA_AUTH_ALLOW_HOSTS,
  MSTEAMS_MEDIA_MAX_MB,
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

function buildMediaItem(params: {
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

  if (isAllowedHost(host, MSTEAMS_MEDIA_AUTH_ALLOW_HOSTS)) {
    logger.debug(
      { host, name: params.filename || null },
      'Skipping Teams attachment that would require scoped auth forwarding',
    );
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

export function buildTeamsAttachmentContext(params: {
  activity: Partial<Activity>;
}): MediaContextItem[] {
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
      const mediaItem = buildMediaItem({
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
        const mediaItem = buildMediaItem({
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
          const mediaItem = buildMediaItem({
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
