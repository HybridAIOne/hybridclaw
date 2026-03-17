import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { type Attachment, type ParsedMail, simpleParser } from 'mailparser';
import { DEFAULT_AGENT_ID } from '../../agents/agent-types.js';
import type { RuntimeEmailConfig } from '../../config/runtime-config.js';
import { buildSessionKey } from '../../session/session-key.js';
import type { MediaContextItem } from '../../types.js';
import { matchesEmailAllowList, normalizeEmailAddress } from './allowlist.js';
import { DEFAULT_EMAIL_SUBJECT } from './constants.js';
import { hasReplySubjectPrefix, type ThreadContext } from './threading.js';

const EMAIL_MEDIA_TMP_PREFIX = 'hybridclaw-email-';

export interface ProcessedEmailInbound {
  sessionId: string;
  guildId: null;
  channelId: string;
  userId: string;
  username: string;
  content: string;
  media: MediaContextItem[];
  senderAddress: string;
  senderName: string;
  subject: string;
  threadContext: ThreadContext | null;
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '_');
}

function normalizeEmailMediaPath(filePath: string): string | null {
  const trimmed = String(filePath || '').trim();
  if (!trimmed) return null;
  return path.resolve(trimmed);
}

function isManagedEmailMediaPath(filePath: string): boolean {
  const normalized = normalizeEmailMediaPath(filePath);
  if (!normalized) return false;
  const tempRoot = path.resolve(os.tmpdir());
  if (
    normalized !== tempRoot &&
    !normalized.startsWith(`${tempRoot}${path.sep}`)
  ) {
    return false;
  }
  const dirName = path.basename(path.dirname(normalized));
  return dirName.startsWith(EMAIL_MEDIA_TMP_PREFIX);
}

function resolveSender(mail: ParsedMail): {
  address: string;
  name: string;
} | null {
  const entries = mail.from?.value || [];
  for (const entry of entries) {
    const address = normalizeEmailAddress(entry.address || '');
    if (!address) continue;
    const name = String(entry.name || '').trim() || address;
    return { address, name };
  }
  const fallback = normalizeEmailAddress(mail.from?.text || '');
  if (!fallback) return null;
  return { address: fallback, name: fallback };
}

function buildThreadContext(mail: ParsedMail): ThreadContext | null {
  const subject = String(mail.subject || '').trim() || DEFAULT_EMAIL_SUBJECT;
  const messageId = String(mail.messageId || '').trim();
  if (!messageId) return null;

  const references = [
    ...(Array.isArray(mail.references)
      ? mail.references
      : mail.references
        ? [mail.references]
        : []),
    mail.inReplyTo || '',
  ]
    .map((entry) => String(entry || '').trim())
    .filter(Boolean);

  return {
    subject,
    messageId,
    references: [...new Set(references)],
  };
}

function buildInboundText(params: {
  mail: ParsedMail;
  subject: string;
  media: MediaContextItem[];
}): string {
  const body = String(params.mail.text || '')
    .replace(/\r\n?/g, '\n')
    .trim();
  const attachmentSummary =
    params.media.length > 0
      ? params.media.map((item) => `[Attachment: ${item.filename}]`).join('\n')
      : '';

  const base = [body, attachmentSummary].filter(Boolean).join('\n\n').trim();
  if (!base) return '';
  if (!params.subject || hasReplySubjectPrefix(params.subject)) {
    return base;
  }
  return `[Subject: ${params.subject}]\n\n${base}`;
}

function buildAttachmentFilename(
  attachment: Attachment,
  index: number,
): string {
  const trimmed = String(attachment.filename || '').trim();
  if (trimmed) return sanitizeFilename(trimmed);

  const contentType = String(attachment.contentType || '').toLowerCase();
  if (contentType.startsWith('image/')) {
    return `attachment-${index + 1}.${contentType.slice('image/'.length) || 'bin'}`;
  }
  if (contentType.startsWith('text/')) {
    return `attachment-${index + 1}.txt`;
  }
  return `attachment-${index + 1}.bin`;
}

async function extractAttachments(
  mail: ParsedMail,
  mediaMaxMb: number,
): Promise<MediaContextItem[]> {
  const maxBytes = Math.max(1, mediaMaxMb) * 1024 * 1024;
  const accepted = mail.attachments.filter(
    (attachment) => attachment.size <= maxBytes,
  );
  if (accepted.length === 0) return [];

  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), EMAIL_MEDIA_TMP_PREFIX),
  );

  const media: MediaContextItem[] = [];
  for (let index = 0; index < accepted.length; index += 1) {
    const attachment = accepted[index];
    const filename = buildAttachmentFilename(attachment, index);
    const filePath = path.join(tempDir, filename);
    await fs.writeFile(filePath, attachment.content);
    media.push({
      path: filePath,
      url: `file://${filePath}`,
      originalUrl: `file://${filePath}`,
      mimeType: attachment.contentType || null,
      sizeBytes: attachment.size,
      filename,
    });
  }
  return media;
}

export async function cleanupEmailInboundMedia(
  media: MediaContextItem[],
): Promise<void> {
  const directories = new Set<string>();
  for (const item of media) {
    const normalized = normalizeEmailMediaPath(item.path || '');
    if (!normalized || !isManagedEmailMediaPath(normalized)) continue;
    directories.add(path.dirname(normalized));
  }

  for (const directory of directories) {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

export async function processInboundEmail(
  raw: Buffer | string,
  config: RuntimeEmailConfig,
  selfAddress: string,
  agentId = DEFAULT_AGENT_ID,
): Promise<ProcessedEmailInbound | null> {
  const mail = await simpleParser(raw);
  const sender = resolveSender(mail);
  if (!sender) return null;

  const normalizedSelf = normalizeEmailAddress(selfAddress);
  if (normalizedSelf && sender.address === normalizedSelf) {
    return null;
  }
  if (!matchesEmailAllowList(config.allowFrom, sender.address)) {
    return null;
  }

  const media = await extractAttachments(mail, config.mediaMaxMb);
  const subject = String(mail.subject || '').trim();
  const content = buildInboundText({ mail, subject, media });
  if (!content && media.length === 0) {
    return null;
  }

  return {
    sessionId: buildSessionKey(agentId, 'email', 'dm', sender.address),
    guildId: null,
    channelId: sender.address,
    userId: sender.address,
    username: sender.name,
    content,
    media,
    senderAddress: sender.address,
    senderName: sender.name,
    subject: subject || DEFAULT_EMAIL_SUBJECT,
    threadContext: buildThreadContext(mail),
  };
}
