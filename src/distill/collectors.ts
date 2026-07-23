import fs from 'node:fs';
import path from 'node:path';
import type { ConfidentialRuleSet } from '../security/confidential-rules.js';
import {
  computeCorpusDocumentId,
  computeQualityWeight,
  countWords,
} from './corpus.js';
import { loadDistillConfidentialRules, maskThirdPartyPii } from './masking.js';
import type { CorpusDocument, CorpusSourceKind } from './types.js';

export interface CollectorContext {
  subject: string;
  matchAliases: string[];
  ruleSet?: ConfidentialRuleSet | null;
  now?: Date;
}

export interface CollectResult {
  documents: CorpusDocument[];
  warnings: string[];
}

const COLLECTABLE_EXTENSIONS = new Set([
  '.json',
  '.jsonl',
  '.mbox',
  '.md',
  '.markdown',
  '.txt',
  '.log',
]);

const TRANSCRIPT_LINE_RE =
  /^(?:\[[^\]]{1,32}\]\s*)?([A-Za-z][\w .'-]{0,48}):\s+\S/;
const INTERVIEW_PAIR_RE =
  /^\s*(?:\*\*)?Q(?:uestion)?\s*[\d.]*\s*(?:\([^)\n]{1,40}\))?\s*[:.]/im;
/** Minimum words for a chat message to also count as standalone long-form. */
const LONGFORM_CHAT_WORDS = 50;

export function collectSourcePath(
  sourcePath: string,
  kind: CorpusSourceKind | 'auto',
  context: CollectorContext,
): CollectResult {
  const resolved = path.resolve(sourcePath);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    return { documents: [], warnings: [`Source not found: ${sourcePath}`] };
  }
  const ctx: CollectorContext = {
    ...context,
    ruleSet:
      context.ruleSet === undefined
        ? loadDistillConfidentialRules()
        : context.ruleSet,
  };
  if (stat.isDirectory()) {
    return collectDirectory(resolved, kind, ctx);
  }
  return collectFile(resolved, kind, ctx);
}

function collectDirectory(
  dir: string,
  kind: CorpusSourceKind | 'auto',
  context: CollectorContext,
): CollectResult {
  const documents: CorpusDocument[] = [];
  const warnings: string[] = [];
  const slackUsers = readSlackUsersMap(dir);
  const entries = fs.readdirSync(dir, { withFileTypes: true, recursive: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (entry.name.startsWith('.')) continue;
    const filePath = path.join(entry.parentPath, entry.name);
    if (filePath.includes(`${path.sep}node_modules${path.sep}`)) continue;
    if (slackUsers && entry.name === 'users.json') continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (!COLLECTABLE_EXTENSIONS.has(ext)) continue;
    const result = collectFile(filePath, kind, context, slackUsers);
    documents.push(...result.documents);
    warnings.push(...result.warnings);
  }
  if (documents.length === 0) {
    warnings.push(`No collectable documents found under ${dir}`);
  }
  return { documents, warnings };
}

function collectFile(
  filePath: string,
  kind: CorpusSourceKind | 'auto',
  context: CollectorContext,
  slackUsers?: Map<string, string> | null,
): CollectResult {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return { documents: [], warnings: [`Unreadable source file: ${filePath}`] };
  }
  if (!raw.trim()) {
    return { documents: [], warnings: [`Empty source file: ${filePath}`] };
  }
  const resolvedKind = kind === 'auto' ? detectSourceKind(filePath, raw) : kind;
  switch (resolvedKind) {
    case 'slack-export':
      return collectSlackExportFile(filePath, raw, context, slackUsers);
    case 'chat-jsonl':
      return collectChatJsonl(filePath, raw, context);
    case 'email-mbox':
      return collectMbox(filePath, raw, context);
    case 'transcript':
      return collectTranscript(filePath, raw, context);
    case 'interview':
      return collectLongForm(filePath, raw, 'interview', context);
    case 'markdown':
      return collectLongForm(filePath, raw, 'markdown', context);
    case 'correction':
      return collectLongForm(filePath, raw, 'correction', context);
    default:
      return collectLongForm(filePath, raw, 'text', context);
  }
}

export function detectSourceKind(
  filePath: string,
  content: string,
): CorpusSourceKind {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.mbox') return 'email-mbox';
  if (ext === '.jsonl') return 'chat-jsonl';
  if (ext === '.json') {
    return looksLikeSlackMessages(content) ? 'slack-export' : 'text';
  }
  if (INTERVIEW_PAIR_RE.test(content) && countInterviewPairs(content) >= 2) {
    return 'interview';
  }
  if (ext === '.md' || ext === '.markdown') return 'markdown';
  const lines = content.split('\n').filter((line) => line.trim());
  if (lines.length >= 5) {
    const speakerLines = lines.filter((line) =>
      TRANSCRIPT_LINE_RE.test(line),
    ).length;
    if (speakerLines / lines.length >= 0.4) return 'transcript';
  }
  return 'text';
}

function countInterviewPairs(content: string): number {
  const matches = content.match(
    /^\s*(?:\*\*)?Q(?:uestion)?\s*[\d.]*\s*(?:\([^)\n]{1,40}\))?\s*[:.]/gim,
  );
  return matches ? matches.length : 0;
}

function looksLikeSlackMessages(content: string): boolean {
  try {
    const parsed = JSON.parse(content);
    if (!Array.isArray(parsed) || parsed.length === 0) return false;
    const sample = parsed[0] as Record<string, unknown>;
    return (
      typeof sample === 'object' &&
      sample !== null &&
      ('ts' in sample || 'user' in sample) &&
      ('text' in sample || 'blocks' in sample)
    );
  } catch {
    return false;
  }
}

function readSlackUsersMap(dir: string): Map<string, string> | null {
  const usersPath = path.join(dir, 'users.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(usersPath, 'utf-8'));
    if (!Array.isArray(parsed)) return null;
    const map = new Map<string, string>();
    for (const user of parsed) {
      const id = String(user?.id || '');
      const name = String(
        user?.profile?.real_name || user?.real_name || user?.name || '',
      );
      if (id && name) map.set(id, name);
    }
    return map.size > 0 ? map : null;
  } catch {
    return null;
  }
}

interface ChatMessage {
  author: string;
  text: string;
  timestamp?: string;
}

function collectSlackExportFile(
  filePath: string,
  raw: string,
  context: CollectorContext,
  slackUsers?: Map<string, string> | null,
): CollectResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      documents: [],
      warnings: [`Invalid Slack export JSON: ${filePath}`],
    };
  }
  if (!Array.isArray(parsed)) {
    return {
      documents: [],
      warnings: [`Invalid Slack export JSON: ${filePath}`],
    };
  }
  const messages: ChatMessage[] = [];
  for (const entry of parsed) {
    const record = entry as Record<string, unknown>;
    const text = String(record.text || '').trim();
    if (!text) continue;
    const userId = String(record.user || record.username || '');
    const author =
      slackUsers?.get(userId) ||
      String(
        (record.user_profile as Record<string, unknown> | undefined)
          ?.real_name || userId,
      ) ||
      'unknown';
    const ts = Number(record.ts || 0);
    messages.push({
      author,
      text,
      timestamp: ts > 0 ? new Date(ts * 1000).toISOString() : undefined,
    });
  }
  const channel = path.basename(path.dirname(filePath));
  return {
    documents: buildChatDocuments(
      filePath,
      'slack-export',
      messages,
      channel,
      context,
    ),
    warnings: [],
  };
}

function collectChatJsonl(
  filePath: string,
  raw: string,
  context: CollectorContext,
): CollectResult {
  const messages: ChatMessage[] = [];
  const warnings: string[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const record = JSON.parse(trimmed) as Record<string, unknown>;
      const text = String(
        record.text || record.content || record.message || record.body || '',
      ).trim();
      if (!text) continue;
      messages.push({
        author: String(
          record.author ||
            record.user ||
            record.from ||
            record.sender ||
            'unknown',
        ),
        text,
        timestamp: normalizeTimestamp(
          record.timestamp ?? record.ts ?? record.date ?? record.time,
        ),
      });
    } catch {
      warnings.push(`Skipped malformed JSONL line in ${filePath}`);
    }
  }
  return {
    documents: buildChatDocuments(
      filePath,
      'chat-jsonl',
      messages,
      undefined,
      context,
    ),
    warnings,
  };
}

/**
 * Chat exports normalize on two levels: one conversation document per file
 * (context preserved, speaker-labelled) plus standalone documents for the
 * subject's own long-form messages, which carry more persona signal than the
 * surrounding chatter.
 */
function buildChatDocuments(
  filePath: string,
  source: CorpusSourceKind,
  messages: ChatMessage[],
  channel: string | undefined,
  context: CollectorContext,
): CorpusDocument[] {
  if (messages.length === 0) return [];
  const documents: CorpusDocument[] = [];
  const conversation = messages
    .map((message) => `[${message.author}] ${message.text}`)
    .join('\n');
  const subjectWrote = messages.some((message) =>
    isSubjectAuthor(message.author, context.matchAliases),
  );
  documents.push(
    finalizeDocument({
      source,
      origin: filePath,
      author: 'conversation',
      authoredBySubject: subjectWrote,
      channel,
      timestamp: messages[0].timestamp,
      content: conversation,
      context,
    }),
  );
  for (const message of messages) {
    if (!isSubjectAuthor(message.author, context.matchAliases)) continue;
    if (countWords(message.text) < LONGFORM_CHAT_WORDS) continue;
    documents.push(
      finalizeDocument({
        source,
        origin: `${filePath}#longform`,
        author: message.author,
        authoredBySubject: true,
        channel,
        timestamp: message.timestamp,
        content: message.text,
        context,
        weightOverride: computeQualityWeight({
          source: 'text',
          wordCount: countWords(message.text),
          authoredBySubject: true,
        }),
      }),
    );
  }
  return documents;
}

function collectMbox(
  filePath: string,
  raw: string,
  context: CollectorContext,
): CollectResult {
  const documents: CorpusDocument[] = [];
  const warnings: string[] = [];
  const chunks = `\n${raw}`.split(/\nFrom /).slice(1);
  if (chunks.length === 0) {
    return { documents, warnings: [`No messages found in mbox: ${filePath}`] };
  }
  for (const chunk of chunks) {
    const headerEnd = chunk.indexOf('\n\n');
    if (headerEnd < 0) continue;
    const headerBlock = chunk.slice(0, headerEnd);
    const body = cleanEmailBody(chunk.slice(headerEnd + 2));
    if (!body.trim()) continue;
    const from = readHeader(headerBlock, 'From') || 'unknown';
    const subjectLine = readHeader(headerBlock, 'Subject') || '(no subject)';
    const date = readHeader(headerBlock, 'Date');
    documents.push(
      finalizeDocument({
        source: 'email-mbox',
        origin: filePath,
        author: from,
        authoredBySubject: isSubjectAuthor(from, context.matchAliases),
        title: subjectLine,
        timestamp: normalizeTimestamp(date),
        content: `Subject: ${subjectLine}\n\n${body}`,
        context,
      }),
    );
  }
  return { documents, warnings };
}

function readHeader(headerBlock: string, name: string): string | undefined {
  const unfolded = headerBlock.replace(/\n[ \t]+/g, ' ');
  const re = new RegExp(`^${name}:\\s*(.+)$`, 'im');
  const match = unfolded.match(re);
  return match ? match[1].trim() : undefined;
}

function cleanEmailBody(body: string): string {
  return body
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('>')) return false;
      if (/^--[\w=-]+/.test(trimmed)) return false;
      if (/^Content-(Type|Transfer-Encoding|Disposition):/i.test(trimmed)) {
        return false;
      }
      if (/^charset=/i.test(trimmed)) return false;
      if (/^[A-Za-z0-9+/=]{60,}$/.test(trimmed)) return false;
      return true;
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function collectTranscript(
  filePath: string,
  raw: string,
  context: CollectorContext,
): CollectResult {
  const lines = raw.split('\n');
  const speakers = new Set<string>();
  for (const line of lines) {
    const match = line.match(TRANSCRIPT_LINE_RE);
    if (match) speakers.add(match[1].trim());
  }
  const subjectSpoke = [...speakers].some((speaker) =>
    isSubjectAuthor(speaker, context.matchAliases),
  );
  return {
    documents: [
      finalizeDocument({
        source: 'transcript',
        origin: filePath,
        author: [...speakers].join(', ') || 'unknown',
        authoredBySubject: subjectSpoke,
        title: path.basename(filePath, path.extname(filePath)),
        content: raw.trim(),
        context,
      }),
    ],
    warnings: [],
  };
}

function collectLongForm(
  filePath: string,
  raw: string,
  source: CorpusSourceKind,
  context: CollectorContext,
): CollectResult {
  const frontmatterAuthor = raw.match(
    /^---[\s\S]*?\nauthor:\s*(.+?)\n[\s\S]*?---/,
  );
  const author = frontmatterAuthor
    ? frontmatterAuthor[1].trim()
    : context.matchAliases[0] || context.subject;
  const title =
    raw.match(/^#\s+(.+)$/m)?.[1].trim() ||
    path.basename(filePath, path.extname(filePath));
  return {
    documents: [
      finalizeDocument({
        source,
        origin: filePath,
        author,
        authoredBySubject: isSubjectAuthor(author, context.matchAliases),
        title,
        content: raw.trim(),
        context,
      }),
    ],
    warnings: [],
  };
}

export function isSubjectAuthor(
  author: string,
  matchAliases: string[],
): boolean {
  const normalized = author.trim().toLowerCase();
  if (!normalized) return false;
  const emailMatch = normalized.match(/<([^>]+)>/);
  const candidates = [normalized];
  if (emailMatch) {
    candidates.push(emailMatch[1], emailMatch[1].split('@')[0]);
    const angleStart = normalized.indexOf('<');
    candidates.push(
      (angleStart >= 0 ? normalized.slice(0, angleStart) : normalized)
        .replace(/"/g, '')
        .trim(),
    );
  }
  return matchAliases.some((alias) => {
    const lowered = alias.trim().toLowerCase();
    if (!lowered) return false;
    return candidates.some(
      (candidate) =>
        candidate === lowered ||
        candidate === lowered.split('@')[0] ||
        (candidate.includes('@') &&
          lowered.startsWith(`${candidate.split('@')[0]}@`)),
    );
  });
}

function normalizeTimestamp(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const date =
    typeof value === 'number'
      ? new Date(value > 1e12 ? value : value * 1000)
      : new Date(String(value));
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function finalizeDocument(params: {
  source: CorpusSourceKind;
  origin: string;
  author: string;
  authoredBySubject: boolean;
  content: string;
  context: CollectorContext;
  title?: string;
  channel?: string;
  timestamp?: string;
  weightOverride?: number;
}): CorpusDocument {
  const masked = maskThirdPartyPii(
    params.content,
    params.context.matchAliases,
    params.context.ruleSet ?? null,
  );
  const wordCount = countWords(masked.text);
  return {
    id: computeCorpusDocumentId(masked.text, params.origin),
    subject: params.context.subject,
    source: params.source,
    origin: params.origin,
    author: params.author,
    authoredBySubject: params.authoredBySubject,
    title: params.title,
    channel: params.channel,
    timestamp: params.timestamp,
    content: masked.text,
    wordCount,
    weight:
      params.weightOverride ??
      computeQualityWeight({
        source: params.source,
        wordCount,
        authoredBySubject: params.authoredBySubject,
      }),
    maskedThirdParties: masked.maskedCount,
    ingestedAt: (params.context.now || new Date()).toISOString(),
  };
}
