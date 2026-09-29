/**
 * Bounded PDF previews are untrusted user content, never system instructions.
 * Unlike the PDF read tool this only previews the current request; persisted
 * conversation/attachment references provide continuity, not a process cache.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { PdfAttachment } from '../../container/shared/pdf-attachments.js';

import {
  PDF_PREVIEW_MAX_CHARS,
  readPdfPages,
} from '../../container/shared/pdf-reader.js';
import type {
  ChatContentPart,
  ChatMessage,
  ChatMessageContent,
} from '../types/api.js';
import type { MediaContextItem } from '../types/container.js';
import { createMediaHostPathResolver } from './media-host-path.js';

// Agent decision, 2026-09-29: bound automatic preview work to four files;
// full-document reading is explicit through read.pages, not automatic ingestion.
const MAX_PREVIEW_FILES = 4;
const PDF_FILE_URL_RE = /file:\/\/[^\s<>"'`\\\]]+\.pdf\b/gi;
const QUOTED_PDF_PATH_RE =
  /(["'`])((?:\.{1,2}[\\/]|~[\\/]|\/|[A-Za-z]:[\\/])[^\n"'`]*?\.pdf)\1/gi;
const BARE_PDF_PATH_RE =
  /(?:^|[\s([{'"])((?:\.{1,2}[\\/]|~[\\/]|\/|[A-Za-z]:[\\/])[^"'`\s)\]}<>,;]*?\.pdf)(?=$|[\s)\]}<>,;:'"])/gi;
const QUOTED_BARE_PDF_FILENAME_RE = /(["'`])([^"'`\n/\\]+\.pdf)\1/gi;

function normalizeMessageContentToText(content: ChatMessageContent): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part): part is Extract<ChatContentPart, { type: 'text' }> => {
      return (
        Boolean(part) && part.type === 'text' && typeof part.text === 'string'
      );
    })
    .map((part) => part.text)
    .join('\n')
    .trim();
}

function cleanCandidate(value: string): string {
  return value
    .trim()
    .replace(/^[`"'[{(]+/, '')
    .replace(/[`"'\\})\],.;:!?]+$/, '');
}
function looksLikePdfReference(value: string): boolean {
  return /\.pdf$/i.test(cleanCandidate(value));
}
function addPdfReference(
  target: string[],
  seen: Set<string>,
  rawValue: string,
): void {
  const cleaned = cleanCandidate(rawValue);
  if (!cleaned) return;
  if (!looksLikePdfReference(cleaned) && !/^file:\/\//i.test(cleaned)) return;
  const key = process.platform === 'win32' ? cleaned.toLowerCase() : cleaned;
  if (seen.has(key)) return;
  seen.add(key);
  target.push(cleaned);
}

function detectPdfReferences(prompt: string): string[] {
  const refs: string[] = [];
  const seen = new Set<string>();
  let match = PDF_FILE_URL_RE.exec(prompt);
  while (match !== null) {
    addPdfReference(refs, seen, match[0]);
    match = PDF_FILE_URL_RE.exec(prompt);
  }
  match = QUOTED_PDF_PATH_RE.exec(prompt);
  while (match !== null) {
    if (match[2]) addPdfReference(refs, seen, match[2]);
    match = QUOTED_PDF_PATH_RE.exec(prompt);
  }
  match = BARE_PDF_PATH_RE.exec(prompt);
  while (match !== null) {
    if (match[1]) addPdfReference(refs, seen, match[1]);
    match = BARE_PDF_PATH_RE.exec(prompt);
  }
  match = QUOTED_BARE_PDF_FILENAME_RE.exec(prompt);
  while (match !== null) {
    if (match[2]) addPdfReference(refs, seen, match[2]);
    match = QUOTED_BARE_PDF_FILENAME_RE.exec(prompt);
  }

  return refs;
}

export async function injectPdfContextMessages(params: {
  messages: ChatMessage[];
  workspaceRoot: string;
  media?: MediaContextItem[];
  pdfMediaAllowed?: boolean;
}): Promise<ChatMessage[]> {
  const { messages, workspaceRoot } = params;
  let latestUserIndex = messages.length - 1;
  while (latestUserIndex >= 0 && messages[latestUserIndex].role !== 'user')
    latestUserIndex -= 1;
  if (latestUserIndex < 0) return messages;
  const text = normalizeMessageContentToText(messages[latestUserIndex].content);
  const references = [
    ...(params.media || [])
      .filter(
        (item) =>
          item.mimeType === 'application/pdf' ||
          /\.pdf$/i.test(item.filename || ''),
      )
      .map((item) => item.path)
      .filter((value): value is string => Boolean(value)),
    ...detectPdfReferences(text),
  ];
  if (references.length === 0) return messages;
  const resolvePath = createMediaHostPathResolver(workspaceRoot);
  const seen = new Set<string>();
  const previews: unknown[] = [];
  const pdfAttachments: PdfAttachment[] = [];
  const candidates = [...new Set(references)];
  const omittedFiles = Math.max(0, candidates.length - MAX_PREVIEW_FILES);
  for (const reference of candidates.slice(0, MAX_PREVIEW_FILES)) {
    const filePath = await resolvePath(reference);
    if (!filePath) {
      previews.push({
        path: reference,
        status: 'unavailable or outside allowed roots',
      });
      continue;
    }
    if (seen.has(filePath)) continue;
    seen.add(filePath);
    const outputDir = params.pdfMediaAllowed
      ? await fs.mkdtemp(path.join(os.tmpdir(), 'hybridclaw-pdf-preview-'))
      : undefined;
    try {
      const {
        pdfAttachments: attachments,
        images,
        ...preview
      } = await readPdfPages(filePath, {
        render: params.pdfMediaAllowed ? 'always' : 'never',
        maxChars: PDF_PREVIEW_MAX_CHARS,
        workspaceRoot: params.pdfMediaAllowed ? workspaceRoot : undefined,
        outputDir,
      });
      pdfAttachments.push(...(attachments || []));
      previews.push({
        path: reference,
        ...preview,
        snapshotId: attachments?.[0]?.id.slice(0, 12),
        renderedPages: images.map((image) => image.page),
        visualDelivery: attachments?.length
          ? 'Selected pages queued for model delivery'
          : 'Text only',
      });
    } catch {
      previews.push({
        path: reference,
        status: 'PDF preview failed; use read for the error',
      });
    } finally {
      if (outputDir) await fs.rm(outputDir, { recursive: true, force: true });
    }
  }
  const preview = `[PDFPreview]\n${JSON.stringify({ previews, omittedFiles })}`;
  const content = messages[latestUserIndex].content;
  const parts: ChatContentPart[] = Array.isArray(content)
    ? [...content, { type: 'text', text: preview }]
    : [
        { type: 'text', text: content || '' },
        { type: 'text', text: preview },
      ];
  return messages.map((message, index) =>
    index === latestUserIndex
      ? {
          ...message,
          content: parts,
          ...(pdfAttachments.length ? { pdfAttachments } : {}),
        }
      : message,
  );
}
