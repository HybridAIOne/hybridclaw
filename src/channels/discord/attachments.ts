import { randomUUID } from 'crypto';
import type {
  Attachment as DiscordAttachment,
  Message as DiscordMessage,
} from 'discord.js';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../../config/config.js';
import { logger } from '../../logger.js';
import type { MediaContextItem } from '../../types.js';

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_ATTACHMENT_CONTEXT_CHARS = 16_000;
const MAX_SINGLE_ATTACHMENT_CHARS = 8_000;
const DISCORD_MEDIA_CACHE_DIR = path.resolve(
  path.join(DATA_DIR, 'discord-media-cache'),
);
const CONTAINER_DISCORD_MEDIA_CACHE_DIR = '/discord-media-cache';
const DISCORD_ATTACHMENT_FETCH_TIMEOUT_MS = 12_000;
const DISCORD_CDN_HOST_PATTERNS: RegExp[] = [
  /^cdn\.discordapp\.com$/i,
  /^media\.discordapp\.net$/i,
  /^cdn\.discordapp\.net$/i,
  /^images-ext-\d+\.discordapp\.net$/i,
];

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

function sanitizeAttachmentFilename(name: string): string {
  const base = name
    .trim()
    .replace(/[^\w.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  const bounded = base.slice(0, 96);
  return bounded || 'attachment';
}

function normalizeAttachmentPathForContainer(hostPath: string): string | null {
  const relative = path.relative(DISCORD_MEDIA_CACHE_DIR, hostPath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
    return null;
  return `${CONTAINER_DISCORD_MEDIA_CACHE_DIR}/${relative.replace(/\\/g, '/')}`;
}

function isAllowedDiscordAttachmentUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  return DISCORD_CDN_HOST_PATTERNS.some((pattern) =>
    pattern.test(parsed.hostname),
  );
}

async function fetchAttachmentText(
  url: string,
  maxChars: number,
): Promise<string | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const text = await response.text();
    if (!text) return null;
    if (text.length <= maxChars) return text;
    return `${text.slice(0, Math.max(1_000, maxChars - 32))}\n...[truncated]`;
  } catch {
    return null;
  }
}

interface CachedDiscordImageResult {
  path: string | null;
  sourceUrl: string;
  mimeType: string | null;
  cacheError?: string;
}

async function cacheDiscordImageAttachment(params: {
  attachment: DiscordAttachment;
  messageId: string;
  order: number;
  fallbackMimeType: string | null;
}): Promise<CachedDiscordImageResult> {
  const { attachment, messageId, order, fallbackMimeType } = params;
  const attachmentName = attachment.name || 'image';
  const sourceCandidates = [attachment.url, attachment.proxyURL]
    .map((value) => String(value || '').trim())
    .filter(Boolean);

  await fs.promises.mkdir(DISCORD_MEDIA_CACHE_DIR, { recursive: true });

  const fetchErrors: string[] = [];
  for (const candidateUrl of sourceCandidates) {
    if (!isAllowedDiscordAttachmentUrl(candidateUrl)) {
      fetchErrors.push(`blocked_url:${candidateUrl}`);
      continue;
    }

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      DISCORD_ATTACHMENT_FETCH_TIMEOUT_MS,
    );
    try {
      const response = await fetch(candidateUrl, { signal: controller.signal });
      if (!response.ok) {
        fetchErrors.push(`http_${response.status}@${candidateUrl}`);
        continue;
      }

      const resolvedMime = String(
        response.headers.get('content-type') || fallbackMimeType || '',
      )
        .split(';')[0]
        .trim()
        .toLowerCase();
      if (!resolvedMime.startsWith('image/')) {
        fetchErrors.push(
          `invalid_type:${resolvedMime || 'unknown'}@${candidateUrl}`,
        );
        continue;
      }

      const contentLength = Number.parseInt(
        response.headers.get('content-length') || '',
        10,
      );
      if (
        Number.isFinite(contentLength) &&
        contentLength > MAX_ATTACHMENT_BYTES
      ) {
        fetchErrors.push(`too_large_header:${contentLength}@${candidateUrl}`);
        continue;
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > MAX_ATTACHMENT_BYTES) {
        fetchErrors.push(`too_large_body:${buffer.length}@${candidateUrl}`);
        continue;
      }

      const unique = randomUUID().slice(0, 8);
      const datePrefix = new Date().toISOString().slice(0, 10);
      const fileName = `${Date.now()}-${messageId}-${String(order).padStart(3, '0')}-${unique}-${sanitizeAttachmentFilename(attachmentName)}`;
      const hostPath = path.join(DISCORD_MEDIA_CACHE_DIR, datePrefix, fileName);
      await fs.promises.mkdir(path.dirname(hostPath), { recursive: true });
      await fs.promises.writeFile(hostPath, buffer);
      const containerPath = normalizeAttachmentPathForContainer(hostPath);
      if (!containerPath) {
        fetchErrors.push(`cache_path_error:${hostPath}`);
        continue;
      }
      return {
        path: containerPath,
        sourceUrl: candidateUrl,
        mimeType: resolvedMime,
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      fetchErrors.push(`fetch_error:${detail}@${candidateUrl}`);
    } finally {
      clearTimeout(timer);
    }
  }

  const fallbackUrl =
    sourceCandidates.find((url) => isAllowedDiscordAttachmentUrl(url)) ||
    sourceCandidates[0] ||
    '';
  return {
    path: null,
    sourceUrl: fallbackUrl,
    mimeType: fallbackMimeType,
    cacheError:
      fetchErrors.length > 0 ? fetchErrors.join(' | ') : 'cache_failed',
  };
}

export async function buildAttachmentContext(
  messages: DiscordMessage[],
): Promise<AttachmentContextResult> {
  const lines: string[] = [];
  const media: MediaContextItem[] = [];
  let remainingChars = MAX_ATTACHMENT_CONTEXT_CHARS;
  let mediaOrder = 0;

  for (const msg of messages) {
    if (!msg.attachments || msg.attachments.size === 0) continue;
    for (const attachment of msg.attachments.values()) {
      const name = attachment.name || 'unnamed';
      const size = attachment.size || 0;
      const contentType = (attachment.contentType || '').toLowerCase();
      if (size > MAX_ATTACHMENT_BYTES) {
        lines.push(
          `- ${name}: skipped (size ${size} bytes exceeds 10MB limit)`,
        );
        if (looksLikeImageAttachment(name, contentType)) {
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
            },
            'Discord image attachment skipped by size limit',
          );
        }
        continue;
      }

      if (looksLikeImageAttachment(name, contentType)) {
        mediaOrder += 1;
        const cached = await cacheDiscordImageAttachment({
          attachment,
          messageId: msg.id,
          order: mediaOrder,
          fallbackMimeType: contentType || null,
        });
        media.push({
          path: cached.path,
          url: cached.sourceUrl || attachment.url,
          originalUrl: attachment.url,
          mimeType: cached.mimeType || contentType || null,
          sizeBytes: size,
          filename: name,
        });
        if (cached.path) {
          lines.push(
            `- ${name}: image attachment cached (${size} bytes, ${cached.mimeType || contentType || 'unknown type'})`,
          );
          logger.info(
            {
              messageId: msg.id,
              attachmentId: attachment.id,
              name,
              sizeBytes: size,
              mimeType: cached.mimeType || contentType || null,
              localPath: cached.path,
            },
            'Discord image attachment cached successfully',
          );
        } else {
          lines.push(
            `- ${name}: image attachment (cache failed, using URL fallback)`,
          );
          logger.warn(
            {
              messageId: msg.id,
              attachmentId: attachment.id,
              name,
              sizeBytes: size,
              mimeType: contentType || null,
              cacheError: cached.cacheError || 'unknown',
            },
            'Discord image attachment cache failed; using CDN fallback',
          );
        }
        continue;
      }

      if (looksLikeTextAttachment(name, contentType)) {
        const maxChars = Math.min(
          MAX_SINGLE_ATTACHMENT_CHARS,
          Math.max(500, remainingChars),
        );
        const text = await fetchAttachmentText(attachment.url, maxChars);
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
