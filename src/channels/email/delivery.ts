import path from 'node:path';
import type { Transporter } from 'nodemailer';
import { EMAIL_TEXT_CHUNK_LIMIT } from '../../config/config.js';
import { logger } from '../../logger.js';
import { chunkMessage } from '../../memory/chunk.js';
import { sleep } from '../../utils/sleep.js';
import { DEFAULT_EMAIL_SUBJECT } from './constants.js';
import {
  createOutboundThreadContext,
  ensureReplySubject,
  type ThreadContext,
} from './threading.js';

const OUTBOUND_DELAY_MS = 350;
const SUBJECT_PREFIX_RE = /^\[subject:\s*([^\]\n]+)\]\s*(?:\n+)?/i;
const FENCE_PLACEHOLDER = '\u0000EMAIL_FENCE_';
const INLINE_CODE_PLACEHOLDER = '\u0000EMAIL_CODE_';

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
}

export interface EmailSendParams {
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
}

function clampTextChunkLimit(limit: number): number {
  return Math.max(500, Math.min(200_000, Math.floor(limit)));
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function restorePlaceholders(
  text: string,
  placeholder: string,
  segments: string[],
): string {
  return text.replace(
    new RegExp(`${escapeRegExp(placeholder)}(\\d+)`, 'g'),
    (_match, index: string) => segments[Number(index)] ?? '',
  );
}

function formatInlineEmailHtml(text: string, fencedBlocks?: string[]): string {
  let result = text;
  const inlineCodeSegments: string[] = [];
  result = result.replace(/`([^`\n]+)`/g, (_match, content: string) => {
    inlineCodeSegments.push(`<code>${escapeHtml(content)}</code>`);
    return `${INLINE_CODE_PLACEHOLDER}${inlineCodeSegments.length - 1}`;
  });

  result = escapeHtml(result);
  result = result.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  result = result.replace(/__(.+?)__/g, '<strong>$1</strong>');
  result = result.replace(
    /(^|[^\w*])\*(\S(?:[^*\n]*?\S)?)\*(?=($|[^\w*]))/g,
    '$1<strong>$2</strong>',
  );
  result = result.replace(
    /(^|[^\w_])_(\S(?:[^_\n]*?\S)?)_(?=($|[^\w_]))/g,
    '$1<em>$2</em>',
  );
  result = result.replace(/~~(.+?)~~/g, '<del>$1</del>');

  result = restorePlaceholders(
    result,
    INLINE_CODE_PLACEHOLDER,
    inlineCodeSegments,
  );
  if (fencedBlocks) {
    result = restorePlaceholders(result, FENCE_PLACEHOLDER, fencedBlocks);
  }
  return result;
}

function renderBlockEmailHtml(block: string, fencedBlocks: string[]): string {
  const trimmed = block.trim();
  if (!trimmed) return '';

  if (/^--\s*$/.test(trimmed)) {
    return '<hr>';
  }

  if (new RegExp(`^${escapeRegExp(FENCE_PLACEHOLDER)}\\d+$`).test(trimmed)) {
    return restorePlaceholders(trimmed, FENCE_PLACEHOLDER, fencedBlocks);
  }

  const lines = trimmed.split('\n');
  if (lines.every((line) => /^\s*[-*]\s+/.test(line))) {
    const items = lines
      .map((line) => line.replace(/^\s*[-*]\s+/, '').trim())
      .filter(Boolean)
      .map((line) => `<li>${formatInlineEmailHtml(line, fencedBlocks)}</li>`)
      .join('');
    return `<ul>${items}</ul>`;
  }

  if (lines.every((line) => /^\s*\d+\.\s+/.test(line))) {
    const items = lines
      .map((line) => line.replace(/^\s*\d+\.\s+/, '').trim())
      .filter(Boolean)
      .map((line) => `<li>${formatInlineEmailHtml(line, fencedBlocks)}</li>`)
      .join('');
    return `<ol>${items}</ol>`;
  }

  return `<p>${lines
    .map((line) => formatInlineEmailHtml(line.trim(), fencedBlocks))
    .join('<br>')}</p>`;
}

export function renderEmailHtml(text: string): string | undefined {
  const normalized = String(text || '')
    .replace(/\r\n?/g, '\n')
    .trim();
  if (!normalized) return undefined;

  const fencedBlocks: string[] = [];
  const prepared = normalized.replace(
    /```(?:[^\n`]*\n)?([\s\S]*?)```/g,
    (_match, content: string) => {
      fencedBlocks.push(
        `<pre><code>${escapeHtml(content.replace(/\n$/, ''))}</code></pre>`,
      );
      return `${FENCE_PLACEHOLDER}${fencedBlocks.length - 1}`;
    },
  );
  const blocks = prepared
    .split(/\n{2,}/)
    .map((block) => renderBlockEmailHtml(block, fencedBlocks))
    .filter(Boolean)
    .join('\n');

  return [
    '<!doctype html>',
    '<html>',
    '<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Arial,sans-serif;line-height:1.5;color:#111827;">',
    blocks,
    '</body>',
    '</html>',
  ].join('');
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
    subject: extracted.subject || DEFAULT_EMAIL_SUBJECT,
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

export async function sendEmail(
  params: EmailSendParams,
): Promise<EmailSendResult> {
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
    const html = renderEmailHtml(text);
    const info = (await params.transport.sendMail({
      from: params.selfAddress,
      to: params.to,
      subject: resolved.subject,
      text: text || undefined,
      html,
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
    })) as MailSendInfo;

    const messageId = String(info.messageId || '').trim();
    const accepted = normalizeRecipientList(info.accepted);
    const rejected = normalizeRecipientList(info.rejected);
    const pending = normalizeRecipientList(info.pending);

    logger.info(
      {
        channel: 'email',
        to: params.to,
        subject: resolved.subject,
        messageId: messageId || null,
        chunkIndex: index + 1,
        chunkCount: effectiveChunks.length,
        hasAttachment: Boolean(params.attachment && index === 0),
        accepted,
        acceptedCount: accepted.length,
        rejected,
        rejectedCount: rejected.length,
        pending,
        pendingCount: pending.length,
        response: String(info.response || '').trim() || null,
      },
      'Email send completed',
    );
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
