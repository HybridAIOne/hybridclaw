import type {
  Attachment as DiscordAttachment,
  Message as DiscordMessage,
} from 'discord.js';

import { logger } from '../../logger.js';
import { AUDIO_FILE_EXTENSION_RE } from '../../media/mime-utils.js';
import type { MediaContextItem } from '../../types.js';
import {
  fetchDiscordCdnBuffer,
  fetchDiscordCdnText,
  isSafeDiscordCdnUrl,
} from './discord-cdn-fetch.js';
import {
  scheduleDiscordMediaCacheCleanup,
  writeDiscordMediaCacheFile,
} from './media-cache.js';

const MAX_IMAGE_ATTACHMENT_BYTES = 6 * 1024 * 1024;
const MAX_DOCUMENT_ATTACHMENT_BYTES = 100 * 1024 * 1024;
const MAX_AUDIO_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_ATTACHMENT_CONTEXT_CHARS = 16_000;
const MAX_SINGLE_ATTACHMENT_CHARS = 8_000;
const DISCORD_ATTACHMENT_FETCH_TIMEOUT_MS = 12_000;

export interface AttachmentContextResult {
  context: string;
  media: MediaContextItem[];
}

export function looksLikeTextAttachment(
  name: string,
  contentType: string,
): boolean {
  if (contentType.startsWith('text/')) return true;
  if (
    contentType.includes('json') ||
    contentType.includes('xml') ||
    contentType.includes('yaml')
  )
    return true;
  return /\.(txt|md|markdown|json|ya?ml|js|jsx|ts|tsx|py|rb|go|rs|java|c|cpp|h|hpp|cs|php|html?|css|scss|sql|log|csv)$/i.test(
    name,
  );
}

function looksLikeImageAttachment(name: string, contentType: string): boolean {
  if (contentType.startsWith('image/')) return true;
  return /\.(png|jpe?g|gif|webp|bmp|svg|heic|heif|tiff?)$/i.test(name);
}

function looksLikePdfAttachment(name: string, contentType: string): boolean {
  if (contentType === 'application/pdf') return true;
  return /\.pdf$/i.test(name);
}

function looksLikeAudioAttachment(name: string, contentType: string): boolean {
  if (contentType.startsWith('audio/')) return true;
  return AUDIO_FILE_EXTENSION_RE.test(name);
}

function looksLikeOfficeAttachment(name: string, contentType: string): boolean {
  if (
    contentType ===
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    contentType ===
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    contentType ===
      'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  ) {
    return true;
  }
  return /\.(docx|xlsx|pptx)$/i.test(name);
}

async function fetchAttachmentText(
  sourceCandidates: string[],
  maxChars: number,
): Promise<string | null> {
  for (const candidateUrl of sourceCandidates) {
    if (!isSafeDiscordCdnUrl(candidateUrl)) continue;
    try {
      const text = await fetchDiscordCdnText(candidateUrl, {
        maxChars,
        timeoutMs: DISCORD_ATTACHMENT_FETCH_TIMEOUT_MS,
      });
      if (text) return text;
    } catch {}
  }
  return null;
}

interface CachedDiscordAttachmentResult {
  path: string | null;
  hostPath: string | null;
  sourceUrl: string;
  mimeType: string | null;
  cacheError?: string;
}

async function cacheDiscordAttachment(params: {
  attachment: DiscordAttachment;
  messageId: string;
  order: number;
  fallbackMimeType: string | null;
  maxBytes?: number;
  acceptMime: (mimeType: string, attachmentName: string) => boolean;
}): Promise<CachedDiscordAttachmentResult> {
  const {
    attachment,
    messageId,
    order,
    fallbackMimeType,
    maxBytes = MAX_DOCUMENT_ATTACHMENT_BYTES,
    acceptMime,
  } = params;
  const attachmentName = attachment.name || 'image';
  const sourceCandidates = [attachment.url, attachment.proxyURL]
    .map((value) => String(value || '').trim())
    .filter(Boolean);

  const fetchErrors: string[] = [];
  for (const candidateUrl of sourceCandidates) {
    if (!isSafeDiscordCdnUrl(candidateUrl)) {
      fetchErrors.push(`blocked_url:${candidateUrl}`);
      continue;
    }

    try {
      const response = await fetchDiscordCdnBuffer(candidateUrl, {
        maxBytes,
        timeoutMs: DISCORD_ATTACHMENT_FETCH_TIMEOUT_MS,
      });
      const resolvedMime = String(
        response.contentType || fallbackMimeType || '',
      )
        .split(';')[0]
        .trim()
        .toLowerCase();
      if (!acceptMime(resolvedMime, attachmentName)) {
        fetchErrors.push(
          `invalid_type:${resolvedMime || 'unknown'}@${candidateUrl}`,
        );
        continue;
      }

      const { hostPath, runtimePath } = await writeDiscordMediaCacheFile({
        attachmentName,
        buffer: response.body,
        messageId,
        order,
      });
      return {
        path: runtimePath,
        hostPath,
        sourceUrl: candidateUrl,
        mimeType: resolvedMime,
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      fetchErrors.push(`${detail}@${candidateUrl}`);
    }
  }

  const fallbackUrl =
    sourceCandidates.find((url) => isSafeDiscordCdnUrl(url)) ||
    sourceCandidates[0] ||
    '';
  return {
    path: null,
    hostPath: null,
    sourceUrl: fallbackUrl,
    mimeType: fallbackMimeType,
    cacheError:
      fetchErrors.length > 0 ? fetchErrors.join(' | ') : 'cache_failed',
  };
}

interface CachedAttachmentDescriptor {
  kind: 'image' | 'pdf' | 'office' | 'audio';
  matches: (name: string, contentType: string) => boolean;
  acceptMime: (mimeType: string, attachmentName: string) => boolean;
  maxBytes: number;
  resolveMimeType: (
    cachedMimeType: string | null,
    contentType: string,
  ) => string | null;
  buildSuccessLine: (params: {
    name: string;
    size: number;
    mimeType: string | null;
    path: string;
  }) => string;
  buildFailureLine: (name: string) => string;
  successLogMessage: string;
  failureLogMessage: string;
  failureLogMimeType: (contentType: string) => string | null;
  includeHostPathInSuccessLog?: boolean;
}

const CACHED_ATTACHMENT_DESCRIPTORS = [
  {
    kind: 'image',
    matches: looksLikeImageAttachment,
    acceptMime: (mimeType) => mimeType.startsWith('image/'),
    maxBytes: MAX_IMAGE_ATTACHMENT_BYTES,
    resolveMimeType: (cachedMimeType, contentType) =>
      cachedMimeType || contentType || null,
    buildSuccessLine: ({ name, size, mimeType }) =>
      `- ${name}: image attachment cached (${size} bytes, ${mimeType || 'unknown type'})`,
    buildFailureLine: (name) =>
      `- ${name}: image attachment (cache failed, using URL fallback)`,
    successLogMessage: 'Discord image attachment cached successfully',
    failureLogMessage:
      'Discord image attachment cache failed; using CDN fallback',
    failureLogMimeType: (contentType) => contentType || null,
  },
  {
    kind: 'pdf',
    matches: looksLikePdfAttachment,
    acceptMime: (mimeType, attachmentName) =>
      mimeType === 'application/pdf' || /\.pdf$/i.test(attachmentName),
    maxBytes: MAX_DOCUMENT_ATTACHMENT_BYTES,
    resolveMimeType: (cachedMimeType, contentType) =>
      cachedMimeType || contentType || 'application/pdf',
    buildSuccessLine: ({ name, size, mimeType }) =>
      `- ${name}: PDF attachment cached (${size} bytes, ${mimeType || 'application/pdf'})`,
    buildFailureLine: (name) =>
      `- ${name}: PDF attachment (cache failed, using URL fallback)`,
    successLogMessage: 'Discord PDF attachment cached successfully',
    failureLogMessage:
      'Discord PDF attachment cache failed; using CDN fallback',
    failureLogMimeType: (contentType) => contentType || 'application/pdf',
    includeHostPathInSuccessLog: true,
  },
  {
    kind: 'office',
    matches: looksLikeOfficeAttachment,
    acceptMime: (mimeType, attachmentName) =>
      looksLikeOfficeAttachment(attachmentName, mimeType),
    maxBytes: MAX_DOCUMENT_ATTACHMENT_BYTES,
    resolveMimeType: (cachedMimeType, contentType) =>
      cachedMimeType || contentType || null,
    buildSuccessLine: ({ name, size, mimeType, path }) =>
      `- ${name}: office attachment cached (${size} bytes, ${mimeType || 'unknown type'}, local path ${path})`,
    buildFailureLine: (name) =>
      `- ${name}: office attachment (cache failed, using URL fallback)`,
    successLogMessage: 'Discord office attachment cached successfully',
    failureLogMessage:
      'Discord office attachment cache failed; using CDN fallback',
    failureLogMimeType: (contentType) => contentType || 'unknown',
    includeHostPathInSuccessLog: true,
  },
  {
    kind: 'audio',
    matches: looksLikeAudioAttachment,
    acceptMime: (mimeType, attachmentName) =>
      mimeType.startsWith('audio/') ||
      looksLikeAudioAttachment(attachmentName, mimeType),
    maxBytes: MAX_AUDIO_ATTACHMENT_BYTES,
    resolveMimeType: (cachedMimeType, contentType) =>
      cachedMimeType || contentType || null,
    buildSuccessLine: ({ name, size, mimeType }) =>
      `- ${name}: audio attachment cached (${size} bytes, ${mimeType || 'unknown type'})`,
    buildFailureLine: (name) =>
      `- ${name}: audio attachment (cache failed, using URL fallback)`,
    successLogMessage: 'Discord audio attachment cached successfully',
    failureLogMessage:
      'Discord audio attachment cache failed; using CDN fallback',
    failureLogMimeType: (contentType) => contentType || 'unknown',
    includeHostPathInSuccessLog: true,
  },
] satisfies readonly CachedAttachmentDescriptor[];

function resolveCachedAttachmentDescriptor(
  name: string,
  contentType: string,
): CachedAttachmentDescriptor | null {
  return (
    CACHED_ATTACHMENT_DESCRIPTORS.find((descriptor) =>
      descriptor.matches(name, contentType),
    ) || null
  );
}

async function appendCachedAttachmentContext(params: {
  descriptor: CachedAttachmentDescriptor;
  attachment: DiscordAttachment;
  messageId: string;
  order: number;
  name: string;
  size: number;
  contentType: string;
  maxBytes: number;
  lines: string[];
  media: MediaContextItem[];
}): Promise<void> {
  const {
    descriptor,
    attachment,
    messageId,
    order,
    name,
    size,
    contentType,
    maxBytes,
    lines,
    media,
  } = params;
  const cached = await cacheDiscordAttachment({
    attachment,
    messageId,
    order,
    fallbackMimeType: contentType || null,
    maxBytes,
    acceptMime: descriptor.acceptMime,
  });
  const mimeType = descriptor.resolveMimeType(cached.mimeType, contentType);
  media.push({
    path: cached.path,
    url: cached.sourceUrl || attachment.url,
    originalUrl: attachment.url,
    mimeType,
    sizeBytes: size,
    filename: name,
  });
  if (cached.path) {
    lines.push(
      descriptor.buildSuccessLine({
        name,
        size,
        mimeType,
        path: cached.path,
      }),
    );
    const logData: Record<string, unknown> = {
      messageId,
      attachmentId: attachment.id,
      name,
      sizeBytes: size,
      mimeType,
      localPath: cached.path,
    };
    if (descriptor.includeHostPathInSuccessLog) {
      logData.hostPath = cached.hostPath;
    }
    logger.info(logData, descriptor.successLogMessage);
    return;
  }

  lines.push(descriptor.buildFailureLine(name));
  logger.warn(
    {
      messageId,
      attachmentId: attachment.id,
      name,
      sizeBytes: size,
      mimeType: descriptor.failureLogMimeType(contentType),
      cacheError: cached.cacheError || 'unknown',
    },
    descriptor.failureLogMessage,
  );
}

export async function buildAttachmentContext(
  messages: DiscordMessage[],
): Promise<AttachmentContextResult> {
  const lines: string[] = [];
  const media: MediaContextItem[] = [];
  let remainingChars = MAX_ATTACHMENT_CONTEXT_CHARS;
  let mediaOrder = 0;
  let cleanupScheduled = false;

  for (const msg of messages) {
    if (!msg.attachments || msg.attachments.size === 0) continue;
    if (!cleanupScheduled) {
      scheduleDiscordMediaCacheCleanup();
      cleanupScheduled = true;
    }
    for (const attachment of msg.attachments.values()) {
      const name = attachment.name || 'unnamed';
      const size = attachment.size || 0;
      const contentType = (attachment.contentType || '').toLowerCase();
      const cachedDescriptor = resolveCachedAttachmentDescriptor(
        name,
        contentType,
      );
      const maxBytes =
        cachedDescriptor?.maxBytes ?? MAX_DOCUMENT_ATTACHMENT_BYTES;
      if (size > maxBytes) {
        lines.push(
          `- ${name}: skipped (size ${size} bytes exceeds ${Math.floor(maxBytes / (1024 * 1024))}MB limit)`,
        );
        if (cachedDescriptor) {
          mediaOrder += 1;
          media.push({
            path: null,
            url: attachment.url,
            originalUrl: attachment.url,
            mimeType: contentType || null,
            sizeBytes: size,
            filename: name,
          });
          logger.warn(
            {
              messageId: msg.id,
              attachmentId: attachment.id,
              name,
              sizeBytes: size,
              attachmentType: cachedDescriptor.kind,
            },
            'Discord attachment skipped by size limit',
          );
        }
        continue;
      }

      if (cachedDescriptor) {
        mediaOrder += 1;
        await appendCachedAttachmentContext({
          descriptor: cachedDescriptor,
          attachment,
          messageId: msg.id,
          order: mediaOrder,
          maxBytes,
          name,
          size,
          contentType,
          lines,
          media,
        });
        continue;
      }

      if (looksLikeTextAttachment(name, contentType)) {
        const maxChars = Math.min(
          MAX_SINGLE_ATTACHMENT_CHARS,
          Math.max(500, remainingChars),
        );
        const text = await fetchAttachmentText(
          [attachment.url, attachment.proxyURL]
            .map((value) => String(value || '').trim())
            .filter(Boolean),
          maxChars,
        );
        if (!text) {
          lines.push(`- ${name}: text attachment (failed to read content)`);
          continue;
        }

        const block = `- ${name} (text attachment):\n\`\`\`\n${text}\n\`\`\``;
        remainingChars -= block.length;
        lines.push(block);
        if (remainingChars <= 0) {
          lines.push(
            '- Additional attachment content omitted (context budget reached).',
          );
          return {
            context: `[Attachments]\n${lines.join('\n')}\n\n`,
            media,
          };
        }
        continue;
      }

      lines.push(
        `- ${name}: attachment (${size} bytes, ${contentType || 'unknown type'})`,
      );
    }
  }

  if (lines.length === 0) return { context: '', media };
  return {
    context: `[Attachments]\n${lines.join('\n')}\n\n`,
    media,
  };
}
