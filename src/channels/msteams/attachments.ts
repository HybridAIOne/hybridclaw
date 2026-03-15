import type { Activity, Attachment } from 'botframework-schema';
import {
  MSTEAMS_MEDIA_ALLOW_HOSTS,
  MSTEAMS_MEDIA_AUTH_ALLOW_HOSTS,
  MSTEAMS_MEDIA_MAX_MB,
} from '../../config/config.js';
import { logger } from '../../logger.js';
import type { MediaContextItem } from '../../types.js';

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

export function buildTeamsAttachmentContext(params: {
  activity: Partial<Activity>;
}): MediaContextItem[] {
  const attachments = Array.isArray(params.activity.attachments)
    ? params.activity.attachments
    : [];
  const maxBytes = Math.max(1, MSTEAMS_MEDIA_MAX_MB) * 1024 * 1024;
  const media: MediaContextItem[] = [];

  for (const attachment of attachments) {
    if (!looksLikeSupportedAttachment(attachment)) continue;

    const url = normalizeValue(attachment.contentUrl);
    if (!url) continue;

    let host = '';
    try {
      host = new URL(url).hostname;
    } catch {
      continue;
    }

    if (isAllowedHost(host, MSTEAMS_MEDIA_AUTH_ALLOW_HOSTS)) {
      logger.debug(
        { host, name: attachment.name || null },
        'Skipping Teams attachment that would require scoped auth forwarding',
      );
      continue;
    }
    if (!isAllowedHost(host, MSTEAMS_MEDIA_ALLOW_HOSTS)) {
      logger.debug(
        { host, name: attachment.name || null },
        'Skipping Teams attachment from non-allowlisted host',
      );
      continue;
    }

    const filename =
      normalizeValue(attachment.name) ||
      normalizeValue(url.split('/').pop()) ||
      'teams-attachment';
    const sizeBytes = Number(
      (attachment as { content?: { size?: number | string } }).content?.size ||
        0,
    );
    if (Number.isFinite(sizeBytes) && sizeBytes > maxBytes) {
      logger.debug(
        { filename, sizeBytes, maxBytes },
        'Skipping Teams attachment that exceeds mediaMaxMb',
      );
      continue;
    }

    media.push({
      path: null,
      url,
      originalUrl: url,
      mimeType: normalizeValue(attachment.contentType) || null,
      sizeBytes: Number.isFinite(sizeBytes) ? sizeBytes : 0,
      filename,
    });
  }

  return media;
}
