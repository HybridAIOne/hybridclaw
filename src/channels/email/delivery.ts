import path from 'node:path';
import type { Transporter } from 'nodemailer';
import { EMAIL_TEXT_CHUNK_LIMIT } from '../../config/config.js';
import { chunkMessage } from '../../memory/chunk.js';
import { sleep } from '../../utils/sleep.js';
import {
  createOutboundThreadContext,
  ensureReplySubject,
  type ThreadContext,
} from './threading.js';

const OUTBOUND_DELAY_MS = 350;
const SUBJECT_PREFIX_RE = /^\[subject:\s*([^\]\n]+)\]\s*(?:\n+)?/i;

type MailTransport = Pick<Transporter, 'sendMail'>;

export interface EmailSendResult {
  messageIds: string[];
  subject: string;
  threadContext: ThreadContext | null;
}

function clampTextChunkLimit(limit: number): number {
  return Math.max(500, Math.min(200_000, Math.floor(limit)));
}

function extractInlineSubject(text: string): {
  subject: string | null;
  body: string;
} {
  const normalized = String(text || '').replace(/\r\n?/g, '\n');
  const match = normalized.match(SUBJECT_PREFIX_RE);
  if (!match?.[1]) {
    return { subject: null, body: normalized.trim() };
  }

  const subject = match[1].trim();
  const body = normalized.slice(match[0].length).trim();
  return {
    subject: subject || null,
    body,
  };
}

function buildThreadHeaders(threadContext: ThreadContext | null): {
  inReplyTo?: string;
  references?: string;
} {
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
): {
  subject: string;
  body: string;
} {
  const extracted = extractInlineSubject(text);
  if (threadContext) {
    return {
      subject: ensureReplySubject(threadContext.subject),
      body: extracted.body,
    };
  }
  return {
    subject: extracted.subject || 'HybridClaw',
    body: extracted.body,
  };
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

async function sendChunkedEmail(params: {
  transport: MailTransport;
  to: string;
  body: string;
  selfAddress: string;
  threadContext: ThreadContext | null;
  attachment?:
    | {
        filePath: string;
        filename?: string | null;
        mimeType?: string | null;
      }
    | undefined;
}): Promise<EmailSendResult> {
  const resolved = resolveSubjectAndBody(params.body, params.threadContext);
  const chunks = prepareEmailTextChunks(resolved.body, {
    allowEmpty: Boolean(params.attachment),
  });

  const effectiveChunks =
    chunks.length > 0 ? chunks : params.attachment ? [''] : ['(no content)'];

  const messageIds: string[] = [];
  let nextThreadContext = params.threadContext;
  for (let index = 0; index < effectiveChunks.length; index += 1) {
    const partPrefix =
      effectiveChunks.length > 1
        ? `[Part ${index + 1}/${effectiveChunks.length}]\n\n`
        : '';
    const text = `${partPrefix}${effectiveChunks[index]}`.trim();
    const info = await params.transport.sendMail({
      from: params.selfAddress,
      to: params.to,
      subject: resolved.subject,
      text: text || undefined,
      ...buildThreadHeaders(nextThreadContext),
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
    });

    const messageId = String(
      (info as { messageId?: string | null }).messageId || '',
    ).trim();
    if (messageId) {
      messageIds.push(messageId);
      nextThreadContext =
        createOutboundThreadContext(
          nextThreadContext,
          messageId,
          resolved.subject,
        ) || nextThreadContext;
    }

    if (index < effectiveChunks.length - 1) {
      await sleep(OUTBOUND_DELAY_MS);
    }
  }

  return {
    messageIds,
    subject: resolved.subject,
    threadContext: nextThreadContext,
  };
}

export async function sendEmailReply(
  transport: MailTransport,
  to: string,
  body: string,
  selfAddress: string,
  threadContext: ThreadContext | null,
): Promise<EmailSendResult> {
  return await sendChunkedEmail({
    transport,
    to,
    body,
    selfAddress,
    threadContext,
  });
}

export async function sendEmailWithAttachment(
  transport: MailTransport,
  to: string,
  body: string,
  selfAddress: string,
  filePath: string,
  threadContext: ThreadContext | null,
  params?: {
    filename?: string | null;
    mimeType?: string | null;
  },
): Promise<EmailSendResult> {
  return await sendChunkedEmail({
    transport,
    to,
    body,
    selfAddress,
    threadContext,
    attachment: {
      filePath,
      filename: params?.filename || null,
      mimeType: params?.mimeType || null,
    },
  });
}
