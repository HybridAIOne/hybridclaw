import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ADDITIONAL_MOUNTS,
  CONTAINER_BINDS,
  CONTAINER_SANDBOX_MODE,
  DATA_DIR,
} from '../config/config.js';
import { logger } from '../logger.js';
import { resolveConfiguredAdditionalMounts } from '../security/mount-config.js';
import { validateAdditionalMounts } from '../security/mount-security.js';
import type {
  ChatContentPart,
  ChatMessage,
  ChatMessageContent,
  MediaContextItem,
} from '../types.js';

const PDF_CONTEXT_HEADER = '[PDFContext]';
const DISCORD_MEDIA_CACHE_ROOT_DISPLAY = '/discord-media-cache';
const WORKSPACE_ROOT_DISPLAY = '/workspace';
const MAX_PDF_CONTEXT_FILES = 4;
const MAX_PDF_CONTEXT_PAGES = 4;
const MAX_PDF_CONTEXT_CHARS = 24_000;
const MAX_SINGLE_PDF_CHARS = 8_000;
const SESSION_PDF_CONTEXT_CACHE_TTL_MS = 10 * 60_000;
const DISCORD_MEDIA_CACHE_ROOT = path.resolve(
  path.join(DATA_DIR, 'discord-media-cache'),
);
const PDF_FILE_URL_RE = /file:\/\/[^\s<>"'`\\\]]+\.pdf\b/gi;
const QUOTED_PDF_PATH_RE =
  /(["'`])((?:\.{1,2}[\\/]|~[\\/]|\/|[A-Za-z]:[\\/])[^\n"'`]*?\.pdf)\1/gi;
const BARE_PDF_PATH_RE =
  /(?:^|[\s([{'"])((?:\.{1,2}[\\/]|~[\\/]|\/|[A-Za-z]:[\\/])[^"'`\s)\]}<>,;]*?\.pdf)(?=$|[\s)\]}<>,;:'"])/gi;
const QUOTED_BARE_PDF_FILENAME_RE = /(["'`])([^"'`\n/\\]+\.pdf)\1/gi;
const APPROVAL_RESPONSE_RE =
  /^(?:\/?(?:approve|yes|y|1|2|3))(?:\s+[a-f0-9-]{6,64})?(?:\s+(?:for\s+session|session|always|for\s+agent|agent))?$/i;
const XML_ESCAPE_MAP: Record<string, string> = {
  '<': '&lt;',
  '>': '&gt;',
  '&': '&amp;',
  '"': '&quot;',
  "'": '&apos;',
};
const PDF_RUNTIME_MODULE_URL = new URL(
  '../../skills/pdf/scripts/_pdf_runtime.mjs',
  import.meta.url,
).href;

interface PdfContextCacheEntry {
  context: string;
  updatedAtMs: number;
}

interface PdfBlockCacheEntry {
  block: string;
  mtimeMs: number;
  size: number;
}

interface ValidatedMountAlias {
  hostPath: string;
  containerPath: string;
}

interface PdfRuntimeModule {
  extractPdfText: (
    inputPath: string,
    pageNumbers?: string,
  ) => Promise<{
    pageCount: number;
    selectedPages: number[];
    pages: Array<{
      pageNumber: number;
      text: string;
    }>;
  }>;
}

const sessionPdfContextCache = new Map<string, PdfContextCacheEntry>();
const pdfBlockCache = new Map<string, PdfBlockCacheEntry>();

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

function trimSessionPdfCache(): void {
  const now = Date.now();
  for (const [sessionId, entry] of sessionPdfContextCache) {
    if (now - entry.updatedAtMs <= SESSION_PDF_CONTEXT_CACHE_TTL_MS) continue;
    sessionPdfContextCache.delete(sessionId);
  }
}

function isWithinRoot(candidate: string, root: string): boolean {
  const resolvedCandidate = path.resolve(candidate);
  const resolvedRoot = path.resolve(root);
  return (
    resolvedCandidate === resolvedRoot ||
    resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`)
  );
}

function normalizePathSlashes(value: string): string {
  return value.replace(/\\/g, '/');
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

function expandUserPath(input: string): string {
  const trimmed = input.trim();
  if (trimmed === '~') return os.homedir();
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  return trimmed;
}

function escapeXmlAttr(value: string): string {
  return value.replace(/[<>&"']/g, (char) => XML_ESCAPE_MAP[char] ?? char);
}

function escapeFileBlockContent(value: string): string {
  return value
    .replace(/<\s*\/\s*file\s*>/gi, '&lt;/file&gt;')
    .replace(/<\s*file\b/gi, '&lt;file');
}

const TRUNCATION_SUFFIX = '\n...[truncated]';

export function clampText(value: string, maxChars: number): string {
  if (maxChars <= 0) return '';
  if (value.length <= maxChars) return value;
  if (maxChars <= TRUNCATION_SUFFIX.length) {
    return value.slice(0, maxChars);
  }

  const head = value.slice(0, maxChars - TRUNCATION_SUFFIX.length).trimEnd();
  if (!head) {
    return value.slice(0, maxChars);
  }
  return `${head}${TRUNCATION_SUFFIX}`;
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

function buildValidatedMountAliases(): ValidatedMountAlias[] {
  const configured = resolveConfiguredAdditionalMounts({
    binds: CONTAINER_BINDS,
    additionalMounts: ADDITIONAL_MOUNTS,
  });
  if (configured.mounts.length === 0) return [];

  return validateAdditionalMounts(configured.mounts).map((mount) => ({
    hostPath: mount.hostPath,
    containerPath: normalizePathSlashes(mount.containerPath),
  }));
}

function resolveDisplayPathToHost(
  rawPath: string,
  workspaceRoot: string,
  mountAliases: ValidatedMountAlias[],
): string | null {
  const normalized = normalizePathSlashes(rawPath);

  for (const alias of mountAliases) {
    if (
      normalized === alias.containerPath ||
      normalized.startsWith(`${alias.containerPath}/`)
    ) {
      const relative = normalized
        .slice(alias.containerPath.length)
        .replace(/^\/+/, '');
      return relative
        ? path.resolve(alias.hostPath, relative)
        : path.resolve(alias.hostPath);
    }
  }

  if (
    normalized === WORKSPACE_ROOT_DISPLAY ||
    normalized.startsWith(`${WORKSPACE_ROOT_DISPLAY}/`)
  ) {
    const relative = normalized
      .slice(WORKSPACE_ROOT_DISPLAY.length)
      .replace(/^\/+/, '');
    return relative
      ? path.resolve(workspaceRoot, relative)
      : path.resolve(workspaceRoot);
  }

  if (
    normalized === DISCORD_MEDIA_CACHE_ROOT_DISPLAY ||
    normalized.startsWith(`${DISCORD_MEDIA_CACHE_ROOT_DISPLAY}/`)
  ) {
    const relative = normalized
      .slice(DISCORD_MEDIA_CACHE_ROOT_DISPLAY.length)
      .replace(/^\/+/, '');
    return relative
      ? path.resolve(DISCORD_MEDIA_CACHE_ROOT, relative)
      : path.resolve(DISCORD_MEDIA_CACHE_ROOT);
  }

  return null;
}

async function resolveCanonicalPath(filePath: string): Promise<string> {
  try {
    return await fs.promises.realpath(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

async function resolveAllowedHostPdfPath(params: {
  rawPath: string;
  workspaceRoot: string;
  mountAliases: ValidatedMountAlias[];
}): Promise<string | null> {
  const { rawPath, workspaceRoot, mountAliases } = params;
  const cleaned = cleanCandidate(rawPath);
  if (!cleaned) return null;

  let candidate = cleaned;
  const explicitAbsoluteInput =
    /^file:\/\//i.test(candidate) ||
    path.isAbsolute(candidate) ||
    /^[A-Za-z]:[\\/]/.test(candidate) ||
    candidate.startsWith('~/') ||
    candidate.startsWith('~\\');
  if (/^file:\/\//i.test(candidate)) {
    try {
      candidate = fileURLToPath(candidate);
    } catch {
      return null;
    }
  }

  const displayResolved = resolveDisplayPathToHost(
    candidate,
    workspaceRoot,
    mountAliases,
  );

  let resolved: string;
  if (displayResolved) {
    resolved = displayResolved;
  } else {
    const expanded = expandUserPath(candidate);
    if (!expanded) return null;

    const hasPathPrefix =
      path.isAbsolute(expanded) ||
      /^[A-Za-z]:[\\/]/.test(expanded) ||
      expanded.startsWith('./') ||
      expanded.startsWith('../') ||
      expanded.startsWith('.\\') ||
      expanded.startsWith('..\\') ||
      expanded.startsWith('~/') ||
      expanded.startsWith('~\\') ||
      expanded.includes('/') ||
      expanded.includes('\\');
    resolved = hasPathPrefix
      ? path.resolve(workspaceRoot, expanded)
      : path.resolve(workspaceRoot, expanded);
  }

  const canonical = await resolveCanonicalPath(resolved);
  const allowedRoots = await Promise.all(
    [
      workspaceRoot,
      DISCORD_MEDIA_CACHE_ROOT,
      ...mountAliases.map((alias) => alias.hostPath),
    ].map((entry) => resolveCanonicalPath(entry)),
  );

  if (!allowedRoots.some((root) => isWithinRoot(canonical, root))) {
    if (!(CONTAINER_SANDBOX_MODE === 'host' && explicitAbsoluteInput)) {
      return null;
    }
  }

  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(canonical);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  if (!/\.pdf$/i.test(canonical)) return null;
  return canonical;
}

function isPdfMediaItem(item: MediaContextItem): boolean {
  const mimeType = String(item.mimeType || '')
    .trim()
    .toLowerCase();
  if (mimeType === 'application/pdf') return true;
  return /\.pdf$/i.test(item.filename || '');
}

async function loadPdfRuntime(): Promise<PdfRuntimeModule> {
  return (await import(PDF_RUNTIME_MODULE_URL)) as PdfRuntimeModule;
}

async function buildPdfFileBlock(filePath: string): Promise<string | null> {
  const canonical = await resolveCanonicalPath(filePath);
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(canonical);
  } catch {
    return null;
  }

  const cached = pdfBlockCache.get(canonical);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.block;
  }

  try {
    const runtime = await loadPdfRuntime();
    const extracted = await runtime.extractPdfText(
      canonical,
      `1-${MAX_PDF_CONTEXT_PAGES}`,
    );
    const pageTexts = extracted.pages
      .map((page) => {
        const text = String(page.text || '')
          .replace(/\n{3,}/g, '\n\n')
          .trim();
        if (!text) return '';
        return extracted.selectedPages.length > 1
          ? `[Page ${page.pageNumber}]\n${text}`
          : text;
      })
      .filter(Boolean);
    if (pageTexts.length === 0) return null;

    let blockText = pageTexts.join('\n\n');
    if (extracted.pageCount > extracted.selectedPages.length) {
      blockText = `[Showing ${extracted.selectedPages.length} of ${extracted.pageCount} page(s)]\n\n${blockText}`;
    }
    blockText = clampText(blockText, MAX_SINGLE_PDF_CHARS);
    const block = `<file name="${escapeXmlAttr(path.basename(canonical))}" mime="application/pdf">\n${escapeFileBlockContent(blockText)}\n</file>`;
    pdfBlockCache.set(canonical, {
      block,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
    });
    return block;
  } catch (error) {
    logger.debug(
      {
        path: canonical,
        error: error instanceof Error ? error.message : String(error),
      },
      'PDF pre-extraction failed',
    );
    return null;
  }
}

function buildPdfContextMessage(blocks: string[]): string {
  const context = blocks.join('\n\n');
  return [
    PDF_CONTEXT_HEADER,
    'Current-turn PDF text extracted from provided local files or attachments. Prefer this content before rediscovery, chat-history reads, `glob`, or workspace-wide search unless the user explicitly asked for those.',
    '',
    clampText(context, MAX_PDF_CONTEXT_CHARS),
  ].join('\n');
}

function findLatestUserMessageIndex(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') return i;
  }
  return -1;
}

export async function injectPdfContextMessages(params: {
  sessionId: string;
  messages: ChatMessage[];
  workspaceRoot: string;
  media?: MediaContextItem[];
}): Promise<ChatMessage[]> {
  trimSessionPdfCache();

  const { sessionId, messages, workspaceRoot } = params;
  const latestUserIndex = findLatestUserMessageIndex(messages);
  if (latestUserIndex < 0) return messages;

  const latestUserText = normalizeMessageContentToText(
    messages[latestUserIndex].content,
  );
  const mountAliases = buildValidatedMountAliases();
  const resolvedPdfPaths: string[] = [];
  const seenCanonicalPaths = new Set<string>();

  const maybeAddResolvedPath = async (rawPath: string): Promise<void> => {
    const resolved = await resolveAllowedHostPdfPath({
      rawPath,
      workspaceRoot,
      mountAliases,
    });
    if (!resolved) return;
    const canonical = await resolveCanonicalPath(resolved);
    if (seenCanonicalPaths.has(canonical)) return;
    seenCanonicalPaths.add(canonical);
    resolvedPdfPaths.push(canonical);
  };

  for (const item of params.media || []) {
    if (!isPdfMediaItem(item)) continue;
    if (item.path) await maybeAddResolvedPath(item.path);
  }

  for (const ref of detectPdfReferences(latestUserText)) {
    await maybeAddResolvedPath(ref);
  }

  const blocks: string[] = [];
  for (const filePath of resolvedPdfPaths.slice(0, MAX_PDF_CONTEXT_FILES)) {
    const block = await buildPdfFileBlock(filePath);
    if (!block) continue;
    blocks.push(block);
  }

  let pdfContext = '';
  if (blocks.length > 0) {
    pdfContext = buildPdfContextMessage(blocks);
    sessionPdfContextCache.set(sessionId, {
      context: pdfContext,
      updatedAtMs: Date.now(),
    });
  } else if (APPROVAL_RESPONSE_RE.test(latestUserText.trim())) {
    const cached = sessionPdfContextCache.get(sessionId);
    if (
      cached &&
      Date.now() - cached.updatedAtMs <= SESSION_PDF_CONTEXT_CACHE_TTL_MS
    ) {
      pdfContext = cached.context;
    }
  }

  if (!pdfContext) return messages;

  const cloned = messages.map((message) => ({ ...message }));
  cloned.splice(latestUserIndex, 0, {
    role: 'system',
    content: pdfContext,
  });
  return cloned;
}
