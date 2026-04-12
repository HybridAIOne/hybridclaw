import path from 'node:path';
import { marked } from 'marked';
import type { Transporter } from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import type Mail from 'nodemailer/lib/mailer/index.js';
import sanitizeHtml from 'sanitize-html';
import { EMAIL_TEXT_CHUNK_LIMIT } from '../../config/config.js';
import { logger } from '../../logger.js';
import { chunkMessage } from '../../memory/chunk.js';
import { sleep } from '../../utils/sleep.js';
import { DEFAULT_EMAIL_SUBJECT } from './constants.js';
import { extractInlineEmailSubject } from './inline-subject.js';
import {
  buildEmailMetadataHeaders,
  type EmailDeliveryMetadata,
} from './metadata.js';
import {
  createOutboundThreadContext,
  ensureReplySubject,
  type ThreadContext,
} from './threading.js';

const OUTBOUND_DELAY_MS = 350;
const SINGLE_ASTERISK_BOLD_RE =
  /(^|[^\w*])\*(\S(?:[^*\n]*?\S)?)\*(?=($|[^\w*]))/g;
const EMAIL_HTML_SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    'a',
    'blockquote',
    'br',
    'code',
    'del',
    'em',
    'hr',
    'li',
    'ol',
    'p',
    'pre',
    'strong',
    'ul',
  ],
  allowedAttributes: {
    a: ['href', 'title'],
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowProtocolRelative: false,
};

type MailTransport = Pick<Transporter, 'sendMail'>;
type MailSendInfo = {
  accepted?: unknown;
  rejected?: unknown;
  pending?: unknown;
  response?: string | null;
  messageId?: string | null;
};

export interface EmailSendResult {
  messageIds: string[];
  subject: string;
  threadContext: ThreadContext | null;
  sentCopies: Array<{
    messageId: string | null;
    raw: Buffer;
  }>;
}

export interface EmailSendParams {
  transport: MailTransport;
  to: string;
  body: string;
  subject?: string | null;
  cc?: string[] | null;
  bcc?: string[] | null;
  inReplyTo?: string | null;
  references?: string[] | null;
  selfAddress: string;
  threadContext: ThreadContext | null;
  metadata?: EmailDeliveryMetadata | null;
  attachment?:
    | {
        filePath: string;
        filename?: string | null;
        mimeType?: string | null;
      }
    | undefined;
}

interface ExplicitThreadHeaders {
  inReplyTo?: string;
  references: string[];
}

function clampTextChunkLimit(limit: number): number {
  return Math.max(500, Math.min(200_000, Math.floor(limit)));
}

function normalizeSingleAsteriskBold(text: string): string {
  return text
    .split(/(`[^`\n]+`)/g)
    .map((segment) =>
      segment.startsWith('`') && segment.endsWith('`')
        ? segment
        : segment.replace(SINGLE_ASTERISK_BOLD_RE, '$1**$2**'),
    )
    .join('');
}

function normalizeEmailMarkdown(text: string): string {
  let inFence = false;
  return text
    .split('\n')
    .map((line) => {
      if (/^```/.test(line.trim())) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      if (/^--\s*$/.test(line.trim())) {
        return '---';
      }
      return normalizeSingleAsteriskBold(line);
    })
    .join('\n');
}

export function renderEmailHtml(text: string): string | undefined {
  const normalized = String(text || '')
    .replace(/\r\n?/g, '\n')
    .trim();
  if (!normalized) return undefined;

  const rendered = marked.parse(normalizeEmailMarkdown(normalized), {
    async: false,
    breaks: true,
    gfm: true,
  });
  const sanitized = sanitizeHtml(
    typeof rendered === 'string' ? rendered : String(rendered || ''),
    EMAIL_HTML_SANITIZE_OPTIONS,
  ).trim();
  if (!sanitized) return undefined;

  return [
    '<!doctype html>',
    '<html>',
    '<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Arial,sans-serif;line-height:1.5;color:#111827;">',
    sanitized,
    '</body>',
    '</html>',
  ].join('');
}

function normalizeMessageId(raw: string | null | undefined): string | null {
  const normalized = String(raw || '').trim();
  return normalized || null;
}

function normalizeMessageIdList(raw: string[] | null | undefined): string[] {
  if (!Array.isArray(raw)) return [];
  return [
    ...new Set(
      raw
        .map((value) => normalizeMessageId(value))
        .filter((value): value is string => Boolean(value)),
    ),
  ];
}

function resolveExplicitThreadHeaders(
  params: EmailSendParams,
): ExplicitThreadHeaders | null {
  let inReplyTo = normalizeMessageId(params.inReplyTo);
  const references = normalizeMessageIdList(params.references);
  if (references.length > 0) {
    const lastReference = references[references.length - 1];
    if (!inReplyTo) {
      inReplyTo = lastReference;
    } else if (references.includes(inReplyTo)) {
      if (lastReference !== inReplyTo) {
        inReplyTo = lastReference;
      }
    } else {
      references.push(inReplyTo);
    }
  } else if (inReplyTo) {
    references.push(inReplyTo);
  }
  if (!inReplyTo && references.length === 0) return null;
  return {
    ...(inReplyTo ? { inReplyTo } : {}),
    references,
  };
}

function buildThreadHeaders(
  threadContext: ThreadContext | null,
  explicitHeaders?: ExplicitThreadHeaders | null,
): {
  inReplyTo?: string;
  references?: string;
} {
  if (explicitHeaders) {
    return {
      ...(explicitHeaders.inReplyTo
        ? { inReplyTo: explicitHeaders.inReplyTo }
        : {}),
      ...(explicitHeaders.references.length > 0
        ? { references: explicitHeaders.references.join(' ') }
        : {}),
    };
  }

  if (!threadContext) return {};

  const references = [
    ...threadContext.references,
    threadContext.messageId,
  ].filter(Boolean);
  return {
    inReplyTo: threadContext.messageId,
    references: references.length > 0 ? references.join(' ') : undefined,
  };
}

function resolveSubjectAndBody(
  text: string,
  threadContext: ThreadContext | null,
  explicitSubject?: string | null,
): {
  subject: string;
  body: string;
} {
  const extracted = extractInlineEmailSubject(text);
  if (threadContext) {
    return {
      subject: ensureReplySubject(threadContext.subject),
      body: extracted.body,
    };
  }
  return {
    subject:
      String(explicitSubject || '').trim() ||
      extracted.subject ||
      DEFAULT_EMAIL_SUBJECT,
    body: extracted.body,
  };
}

function normalizeRecipientList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const normalized: string[] = [];
  for (const value of raw) {
    const candidate = String(value || '').trim();
    if (!candidate) continue;
    normalized.push(candidate);
  }
  return normalized;
}

export function prepareEmailTextChunks(
  text: string,
  options?: { allowEmpty?: boolean },
): string[] {
  const chunks = chunkMessage(String(text || '').trim(), {
    maxChars: clampTextChunkLimit(EMAIL_TEXT_CHUNK_LIMIT),
    maxLines: 2_000,
  }).filter((chunk) => chunk.trim().length > 0);

  if (chunks.length > 0) return chunks;
  return options?.allowEmpty ? [] : ['(no content)'];
}

async function buildRawMailCopy(mail: Mail.Options): Promise<{
  messageId: string | null;
  raw: Buffer;
}> {
  const composer = new MailComposer(mail);
  const message = composer.compile();
  const messageId = normalizeMessageId(message.messageId());
  return {
    messageId,
    raw: await message.build(),
  };
}

export async function sendEmail(
  params: EmailSendParams,
): Promise<EmailSendResult> {
  const explicitThreadHeaders = resolveExplicitThreadHeaders(params);
  const subjectThreadContext = explicitThreadHeaders
    ? null
    : params.threadContext;
  const resolved = resolveSubjectAndBody(
    params.body,
    subjectThreadContext,
    params.subject,
  );
  const chunks = prepareEmailTextChunks(resolved.body, {
    allowEmpty: Boolean(params.attachment),
  });
  const cc =
    Array.isArray(params.cc) && params.cc.length > 0 ? params.cc : undefined;
  const bcc =
    Array.isArray(params.bcc) && params.bcc.length > 0 ? params.bcc : undefined;

  // Attachment-only sends still need a single outbound message when the body
  // is intentionally empty.
  const effectiveChunks = chunks.length > 0 ? chunks : [''];
  const metadataHeaders = buildEmailMetadataHeaders(params.metadata);

  const messageIds: string[] = [];
  const sentCopies: Array<{ messageId: string | null; raw: Buffer }> = [];
  let nextThreadContext = explicitThreadHeaders
    ? {
        subject: resolved.subject,
        messageId:
          explicitThreadHeaders.inReplyTo ||
          explicitThreadHeaders.references[
            explicitThreadHeaders.references.length - 1
          ] ||
          '',
        references: explicitThreadHeaders.references,
      }
    : params.threadContext;
  let firstChunkHeaders = explicitThreadHeaders;
  for (let index = 0; index < effectiveChunks.length; index += 1) {
    const partPrefix =
      effectiveChunks.length > 1
        ? `[Part ${index + 1}/${effectiveChunks.length}]\n\n`
        : '';
    const text = `${partPrefix}${effectiveChunks[index]}`.trim();
    const html = renderEmailHtml(text);
    const mail: Mail.Options = {
      from: params.selfAddress,
      to: params.to,
      ...(cc ? { cc } : {}),
      ...(bcc ? { bcc } : {}),
      subject: resolved.subject,
      text: text || undefined,
      html,
      ...(metadataHeaders ? { headers: metadataHeaders } : {}),
      ...buildThreadHeaders(nextThreadContext, firstChunkHeaders),
      attachments:
        params.attachment && index === 0
          ? [
              {
                path: params.attachment.filePath,
                filename:
                  String(params.attachment.filename || '').trim() ||
                  path.basename(params.attachment.filePath),
                contentType: params.attachment.mimeType || undefined,
              },
            ]
          : undefined,
    };
    const rawCopy = await buildRawMailCopy(mail);
    sentCopies.push(rawCopy);

    const info = (await params.transport.sendMail({
      ...mail,
      ...(rawCopy.messageId ? { messageId: rawCopy.messageId } : {}),
    })) as MailSendInfo;

    const messageId = String(info.messageId || rawCopy.messageId || '').trim();
    const accepted = normalizeRecipientList(info.accepted);
    const rejected = normalizeRecipientList(info.rejected);
    const pending = normalizeRecipientList(info.pending);
    const response = String(info.response || '').trim() || null;
    const deliveryLog = {
      channel: 'email',
      to: params.to,
      ...(cc ? { cc } : {}),
      ...(bcc ? { bcc } : {}),
      subject: resolved.subject,
      messageId: messageId || null,
      chunkIndex: index + 1,
      chunkCount: effectiveChunks.length,
      hasAttachment: Boolean(params.attachment && index === 0),
      response,
    };

    logger.info(deliveryLog, 'Email send completed');
    if (rejected.length > 0 || pending.length > 0) {
      logger.warn(
        {
          ...deliveryLog,
          accepted: accepted.length > 0 ? accepted : undefined,
          acceptedCount: accepted.length,
          rejected: rejected.length > 0 ? rejected : undefined,
          rejectedCount: rejected.length,
          pending: pending.length > 0 ? pending : undefined,
          pendingCount: pending.length,
        },
        'Email send reported recipient delivery issues',
      );
    }
    if (messageId) {
      messageIds.push(messageId);
      nextThreadContext =
        createOutboundThreadContext(
          nextThreadContext,
          messageId,
          resolved.subject,
        ) || nextThreadContext;
    }
    firstChunkHeaders = null;

    if (index < effectiveChunks.length - 1) {
      await sleep(OUTBOUND_DELAY_MS);
    }
  }

  return {
    messageIds,
    subject: resolved.subject,
    threadContext: nextThreadContext,
    sentCopies,
  };
}
