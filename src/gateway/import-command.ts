/**
 * `/import` — brings what the user already told another assistant into the
 * agent's memory. Companion apps send it in two steps:
 *
 * 1. `/import <source> --json` with uploaded media stages the files in the
 *    agent's workspace under `imports/<id>/`. ChatGPT and Claude exports are
 *    unpacked into `conversations.md`, a digest of the user's own messages;
 *    pasted text, OpenClaw and Hermes memory files and other documents are
 *    kept as they are. The answer names the staged files, in one line that
 *    survives a chat relay (`chatSafeJson`).
 * 2. `/import review <id>` continues into one ordinary turn of the agent
 *    (`continueWith`), told to fold what matters into USER.md and MEMORY.md
 *    and to say what it learned. The fixed steps go into the turn's operator
 *    instructions, so the stored user message stays one plain sentence.
 *
 * Nothing is written to USER.md or MEMORY.md here: the agent decides what is
 * worth keeping, the same way it does in conversation.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { agentWorkspaceDir } from '../infra/ipc.js';
import { createMediaHostPathResolver } from '../media/media-host-path.js';
import { badCommand, plainCommand } from './gateway-command-results.js';
import type {
  GatewayCommandRequest,
  GatewayCommandResult,
} from './gateway-types.js';
import { chatSafeJson } from './schedule-command.js';

export const IMPORT_SOURCES = [
  'chatgpt',
  'claude',
  'openclaw',
  'hermes',
  'files',
] as const;
export type ImportSource = (typeof IMPORT_SOURCES)[number];

const SOURCE_LABELS: Record<ImportSource, string> = {
  chatgpt: 'ChatGPT',
  claude: 'Claude',
  openclaw: 'OpenClaw',
  hermes: 'Hermes Agent',
  files: 'files',
};

// The stored user message of the review turn.
const REVIEW_MESSAGES: Record<ImportSource, string> = {
  chatgpt: 'Import what ChatGPT knows about me.',
  claude: 'Import what Claude knows about me.',
  openclaw: 'Import my memory from OpenClaw.',
  hermes: 'Import my memory from Hermes Agent.',
  files: 'Read the files I shared about me.',
};

export const IMPORTS_DIR = 'imports';
export const CONVERSATION_DIGEST_FILE = 'conversations.md';

// The digest is read in one turn, so it keeps the newest conversations that
// fit. About 30k tokens; a message is cut after 1,500 characters.
export const CONVERSATION_DIGEST_MAX_CHARS = 120_000;
const MESSAGE_MAX_CHARS = 1_500;
// Kept files besides the digest.
const KEPT_FILES_MAX = 50;
const KEPT_FILE_MAX_BYTES = 10 * 1024 * 1024;
const KEPT_TOTAL_MAX_BYTES = 30 * 1024 * 1024;
// A conversations file is parsed whole.
const CONVERSATIONS_FILE_MAX_BYTES = 300 * 1024 * 1024;

const DOCUMENT_EXTENSIONS = new Set([
  '.md',
  '.markdown',
  '.txt',
  '.json',
  '.csv',
  '.pdf',
  '.docx',
  '.xlsx',
  '.pptx',
  '.html',
  '.htm',
  '.xml',
  '.yaml',
  '.yml',
]);
const TEXT_EXTENSIONS = new Set(['.md', '.markdown', '.txt']);
// Agent homes hold settings and keys next to their memory; only notes go.
const SKIPPED_DIRECTORIES = new Set([
  '__MACOSX',
  '.git',
  'node_modules',
  'skills',
  '.agents',
  'sessions',
  'logs',
  'cache',
]);
const CONVERSATIONS_FILE = /^conversations(?:-\d+)?\.json$/i;
const IMPORT_ID =
  /^(chatgpt|claude|openclaw|hermes|files)-\d{8}-\d{6}(?:-\d+)?$/;

const USAGE =
  'Usage: `/import <chatgpt|claude|openclaw|hermes|files>` with attached files stages them for the agent, `/import review <id>` lets the agent read them into its memory. Add `--json` for a machine-readable answer.';

export interface ExportConversation {
  title: string;
  /** Milliseconds since 1970, or null when the export has no time. */
  time: number | null;
  /** The user's own messages, oldest first. */
  messages: string[];
}

export interface ChatExport {
  conversations: ExportConversation[];
  /** What the user wrote about themselves in the other assistant's settings. */
  profile: string[];
}

type ImportErrorCode =
  | 'unknown-source'
  | 'no-files'
  | 'unreadable'
  | 'nothing-found'
  | 'unknown-import';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function seconds(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.round(value * 1000)
    : null;
}

function isoTime(value: unknown): number | null {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

// ChatGPT keeps a conversation as a tree of edits; the branch that ends at
// `current_node` is the one the user saw last.
function chatGptBranch(
  mapping: Record<string, unknown>,
  current: unknown,
): Record<string, unknown>[] {
  const nodes: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  let id = typeof current === 'string' ? current : null;
  while (id && !seen.has(id)) {
    seen.add(id);
    const node = mapping[id];
    if (!isRecord(node)) break;
    nodes.push(node);
    id = typeof node.parent === 'string' ? node.parent : null;
  }
  if (nodes.length > 0) return nodes.reverse();
  // Without a current node, every message in the order ChatGPT stored it.
  return Object.values(mapping).filter(isRecord);
}

function chatGptText(content: Record<string, unknown>): string {
  const parts = Array.isArray(content.parts) ? content.parts : [];
  return parts
    .map((part) => (typeof part === 'string' ? part : text(part)))
    .filter(Boolean)
    .join('\n')
    .trim();
}

/** ChatGPT's `conversations.json`: the user's messages and custom instructions. */
export function chatGptExport(data: unknown): ChatExport {
  const conversations: ExportConversation[] = [];
  const profile: string[] = [];
  for (const raw of Array.isArray(data) ? data : []) {
    if (!isRecord(raw) || !isRecord(raw.mapping)) continue;
    const messages: string[] = [];
    for (const node of chatGptBranch(raw.mapping, raw.current_node)) {
      const message = node.message;
      if (!isRecord(message) || !isRecord(message.content)) continue;
      const content = message.content;
      if (content.content_type === 'user_editable_context') {
        for (const field of [content.user_profile, content.user_instructions]) {
          const entry = text(field);
          if (entry && !profile.includes(entry)) profile.push(entry);
        }
        continue;
      }
      const author = isRecord(message.author) ? message.author.role : null;
      if (author !== 'user') continue;
      if (
        content.content_type !== 'text' &&
        content.content_type !== 'multimodal_text'
      ) {
        continue;
      }
      const body = chatGptText(content);
      if (body) messages.push(body);
    }
    if (messages.length === 0) continue;
    conversations.push({
      title: text(raw.title),
      time: seconds(raw.update_time) ?? seconds(raw.create_time),
      messages,
    });
  }
  return { conversations, profile };
}

function claudeText(message: Record<string, unknown>): string {
  const direct = text(message.text);
  if (direct) return direct;
  const blocks = Array.isArray(message.content) ? message.content : [];
  return blocks
    .map((block) =>
      isRecord(block) && block.type === 'text' ? text(block.text) : '',
    )
    .filter(Boolean)
    .join('\n')
    .trim();
}

/** Claude's `conversations.json`: the user's messages. */
export function claudeExport(data: unknown): ChatExport {
  const conversations: ExportConversation[] = [];
  for (const raw of Array.isArray(data) ? data : []) {
    if (!isRecord(raw) || !Array.isArray(raw.chat_messages)) continue;
    const messages = raw.chat_messages
      .filter(
        (message): message is Record<string, unknown> =>
          isRecord(message) && message.sender === 'human',
      )
      .map(claudeText)
      .filter(Boolean);
    if (messages.length === 0) continue;
    conversations.push({
      title: text(raw.name),
      time: isoTime(raw.updated_at) ?? isoTime(raw.created_at),
      messages,
    });
  }
  return { conversations, profile: [] };
}

/** Claude's `projects.json`: what the user wrote to set up each project. */
export function claudeProjects(data: unknown): string[] {
  const notes: string[] = [];
  for (const raw of Array.isArray(data) ? data : []) {
    if (!isRecord(raw)) continue;
    const name = text(raw.name);
    const about = [text(raw.description), text(raw.prompt_template)]
      .filter(Boolean)
      .join('\n');
    if (name && about) notes.push(`${name}: ${about}`);
  }
  return notes;
}

function oneLine(message: string): string {
  const flat = message.replace(/\s+/g, ' ').trim();
  return flat.length > MESSAGE_MAX_CHARS
    ? `${flat.slice(0, MESSAGE_MAX_CHARS).trimEnd()}…`
    : flat;
}

function day(time: number | null): string {
  return time === null ? 'undated' : new Date(time).toISOString().slice(0, 10);
}

/**
 * The digest the agent reads: what the user wrote about themselves, then
 * their messages, newest conversation first, as many as fit `maxChars`.
 */
export function renderConversationDigest(
  label: string,
  chat: ChatExport,
  maxChars = CONVERSATION_DIGEST_MAX_CHARS,
): { markdown: string; kept: number; omitted: number } {
  const sorted = [...chat.conversations].sort(
    (a, b) => (b.time ?? 0) - (a.time ?? 0),
  );
  const head = [`# The user's messages in ${label}`, ''];
  if (chat.profile.length > 0) {
    head.push(`## What they wrote about themselves in ${label}'s settings`, '');
    for (const entry of chat.profile) head.push(oneLine(entry), '');
  }
  const sections: string[] = [];
  let used = head.join('\n').length;
  for (const conversation of sorted) {
    const lines = [
      `## ${day(conversation.time)} · ${oneLine(conversation.title) || 'Untitled'}`,
      '',
      ...conversation.messages.map((message) => `- ${oneLine(message)}`),
      '',
    ].join('\n');
    if (used + lines.length > maxChars && sections.length > 0) break;
    sections.push(lines);
    used += lines.length;
  }
  const omitted = sorted.length - sections.length;
  const note =
    omitted > 0
      ? `Newest first: ${sections.length} of ${sorted.length} conversations; older ones were left out.`
      : `Newest first: all ${sorted.length} conversations.`;
  return {
    markdown: `${[...head, note, '', ...sections].join('\n').trimEnd()}\n`,
    kept: sections.length,
    omitted,
  };
}

function walkFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || SKIPPED_DIRECTORIES.has(entry.name)) {
        continue;
      }
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(entryPath);
      else if (entry.isFile()) files.push(entryPath);
    }
  };
  walk(root);
  return files.sort();
}

function safeRelativePath(relative: string): string {
  return relative
    .split(/[\\/]+/)
    .map((part) => part.replace(/[^\p{L}\p{N}._ -]+/gu, '_').trim())
    .filter((part) => part && part !== '.' && part !== '..')
    .join('/');
}

// Which unpacked or uploaded files the agent gets to read. Chat exports keep
// only notes about memory besides the digest: their other files hold account
// data, not things the user said.
function keepsFile(source: ImportSource, relative: string): boolean {
  const name = path.basename(relative).toLowerCase();
  const extension = path.extname(name);
  if (name === '.env' || name.endsWith('.json.bak')) return false;
  switch (source) {
    case 'chatgpt':
    case 'claude':
      return (
        TEXT_EXTENSIONS.has(extension) ||
        (extension === '.json' && name.includes('memor'))
      );
    case 'openclaw':
    case 'hermes':
      return TEXT_EXTENSIONS.has(extension);
    case 'files':
      return DOCUMENT_EXTENSIONS.has(extension);
  }
}

function isZip(filename: string, mimeType: string | null): boolean {
  if (filename.toLowerCase().endsWith('.zip')) return true;
  if (mimeType === 'application/zip') return true;
  if (mimeType === 'application/x-zip-compressed') return true;
  return false;
}

class ImportFailure extends Error {
  constructor(readonly code: ImportErrorCode) {
    super(code);
  }
}

function timestampId(source: ImportSource, workspace: string, now: Date) {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace('T', '-')
    .slice(0, 15);
  const base = `${source}-${stamp}`;
  let id = base;
  for (let n = 2; fs.existsSync(path.join(workspace, IMPORTS_DIR, id)); n++) {
    id = `${base}-${n}`;
  }
  return id;
}

interface StagedImport {
  id: string;
  files: string[];
  conversations: number;
  omitted: number;
}

async function stage(params: {
  source: ImportSource;
  workspace: string;
  uploads: { hostPath: string; filename: string; mimeType: string | null }[];
  now: Date;
}): Promise<StagedImport> {
  const { source, workspace, uploads } = params;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-import-'));
  try {
    // Every upload as a folder of files: a zip unpacked, anything else alone.
    const roots: string[] = [];
    for (const [index, upload] of uploads.entries()) {
      const root = path.join(scratch, String(index));
      if (isZip(upload.filename, upload.mimeType)) {
        const { safeExtractZip } = await import('../agents/claw-security.js');
        try {
          await safeExtractZip(upload.hostPath, root);
        } catch {
          throw new ImportFailure('unreadable');
        }
      } else {
        fs.mkdirSync(root, { recursive: true });
        fs.copyFileSync(
          upload.hostPath,
          path.join(root, safeRelativePath(upload.filename) || 'file'),
        );
      }
      roots.push(root);
    }

    const chat: ChatExport = { conversations: [], profile: [] };
    const kept: { from: string; relative: string }[] = [];
    let keptBytes = 0;
    for (const root of roots) {
      for (const file of walkFiles(root)) {
        const relative = path.relative(root, file);
        const name = path.basename(file);
        const size = fs.statSync(file).size;
        if (
          (source === 'chatgpt' || source === 'claude') &&
          CONVERSATIONS_FILE.test(name)
        ) {
          if (size > CONVERSATIONS_FILE_MAX_BYTES) continue;
          let data: unknown;
          try {
            data = JSON.parse(fs.readFileSync(file, 'utf-8'));
          } catch {
            continue;
          }
          const parsed =
            source === 'chatgpt' ? chatGptExport(data) : claudeExport(data);
          chat.conversations.push(...parsed.conversations);
          chat.profile.push(...parsed.profile);
          continue;
        }
        if (source === 'claude' && name.toLowerCase() === 'projects.json') {
          try {
            chat.profile.push(
              ...claudeProjects(JSON.parse(fs.readFileSync(file, 'utf-8'))),
            );
          } catch {
            // A projects file we can't read adds nothing.
          }
          continue;
        }
        if (!keepsFile(source, relative)) continue;
        if (size === 0 || size > KEPT_FILE_MAX_BYTES) continue;
        if (kept.length >= KEPT_FILES_MAX) continue;
        if (keptBytes + size > KEPT_TOTAL_MAX_BYTES) continue;
        keptBytes += size;
        kept.push({
          from: file,
          relative:
            roots.length > 1
              ? path.join(String(roots.indexOf(root) + 1), relative)
              : relative,
        });
      }
    }

    const hasChat = chat.conversations.length > 0 || chat.profile.length > 0;
    if (!hasChat && kept.length === 0) {
      throw new ImportFailure('nothing-found');
    }

    const id = timestampId(source, workspace, params.now);
    const target = path.join(workspace, IMPORTS_DIR, id);
    fs.mkdirSync(target, { recursive: true });
    const files: string[] = [];
    let conversations = 0;
    let omitted = 0;
    if (hasChat) {
      const digest = renderConversationDigest(SOURCE_LABELS[source], chat);
      fs.writeFileSync(
        path.join(target, CONVERSATION_DIGEST_FILE),
        digest.markdown,
        'utf-8',
      );
      files.push(CONVERSATION_DIGEST_FILE);
      conversations = digest.kept;
      omitted = digest.omitted;
    }
    for (const file of kept) {
      let relative = safeRelativePath(file.relative) || 'file';
      if (relative === CONVERSATION_DIGEST_FILE) relative = `own-${relative}`;
      const destination = path.join(target, relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(file.from, destination);
      files.push(relative);
    }
    return { id, files, conversations, omitted };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function failure(code: ImportErrorCode, json: boolean): GatewayCommandResult {
  if (json) return plainCommand(chatSafeJson({ version: 1, error: code }));
  const messages: Record<ImportErrorCode, string> = {
    'unknown-source': USAGE,
    'no-files': 'Attach the files to import.',
    unreadable: 'That zip file could not be opened.',
    'nothing-found': 'Those files hold nothing the agent can import.',
    'unknown-import': 'There is no such import.',
  };
  return badCommand('Import', messages[code]);
}

/** The turn that reads a staged import into USER.md and MEMORY.md. */
export function reviewInstructions(
  source: ImportSource,
  id: string,
  files: string[],
): string {
  const from =
    source === 'files'
      ? 'files about themselves'
      : `what they told ${SOURCE_LABELS[source]}`;
  const listed = files.map((file) =>
    file === CONVERSATION_DIGEST_FILE
      ? `- \`${IMPORTS_DIR}/${id}/${file}\`: their own messages in ${SOURCE_LABELS[source]}, newest first`
      : `- \`${IMPORTS_DIR}/${id}/${file}\``,
  );
  return [
    `The user is importing ${from}, so you know them from the start. The files are in your workspace:`,
    ...listed,
    '',
    'Do this now, in this turn:',
    '1. Read every file. Read long files in parts.',
    '2. Update USER.md with who they are: name, where they live, work, family and the people they mention, interests, and how they like answers. Fill empty fields and add short bullets under "Context". Keep "What to call them" and "Timezone" unless they are empty.',
    '3. Update MEMORY.md with durable facts: ongoing projects, goals, routines, preferences and important dates, as short bullets under its headings.',
    '4. Merge with what is already there instead of repeating it. Where facts conflict, the newer one wins. Keep USER.md under 8,000 and MEMORY.md under 12,000 characters. Edit the files with your edit or write tool.',
    '5. Keep only what helps you help them. Leave out passwords, keys, card and account numbers, one-off questions, and private details about other people. Never invent anything.',
    '6. Then answer in the language they write to you in, in a few short lines: the most useful things you now know about them, and that they can ask you to forget anything. Do not mention file names or paths.',
    '',
    `The files stay in \`${IMPORTS_DIR}/${id}/\`, so you can look things up there later.`,
  ].join('\n');
}

function review(
  id: string,
  agentId: string,
  json: boolean,
): GatewayCommandResult {
  const match = IMPORT_ID.exec(id);
  const folder = path.join(agentWorkspaceDir(agentId), IMPORTS_DIR, id);
  if (!match || !fs.existsSync(folder)) return failure('unknown-import', json);
  const source = match[1] as ImportSource;
  const files = walkFiles(folder).map((file) =>
    path.relative(folder, file).split(path.sep).join('/'),
  );
  if (files.length === 0) return failure('nothing-found', json);
  return {
    ...plainCommand(`Reading the import ${id}.`),
    continueWith: {
      content: REVIEW_MESSAGES[source],
      instructions: reviewInstructions(source, id, files),
    },
  };
}

export async function handleImportCommand(
  req: GatewayCommandRequest,
  agentId: string,
  now = new Date(),
): Promise<GatewayCommandResult> {
  const rest = req.args.slice(1).map(String);
  const json = rest.includes('--json');
  const [sub = '', ...operands] = rest.filter((arg) => arg !== '--json');
  const action = sub.toLowerCase();
  if (action === 'review' && operands.length === 1) {
    return review(operands[0] || '', agentId, json);
  }
  if (
    operands.length > 0 ||
    !(IMPORT_SOURCES as readonly string[]).includes(action)
  ) {
    return json ? failure('unknown-source', json) : badCommand('Usage', USAGE);
  }
  const source = action as ImportSource;

  const workspace = agentWorkspaceDir(agentId);
  const resolveHostPath = createMediaHostPathResolver(workspace);
  const uploads: {
    hostPath: string;
    filename: string;
    mimeType: string | null;
  }[] = [];
  for (const item of req.media ?? []) {
    const hostPath = item.path ? await resolveHostPath(item.path) : null;
    if (!hostPath) continue;
    uploads.push({
      hostPath,
      filename: item.filename || path.basename(hostPath),
      mimeType: item.mimeType,
    });
  }
  if (uploads.length === 0) return failure('no-files', json);

  try {
    const staged = await stage({ source, workspace, uploads, now });
    if (json) {
      return plainCommand(
        chatSafeJson({
          version: 1,
          id: staged.id,
          source,
          files: staged.files,
          conversations: staged.conversations,
          omitted: staged.omitted,
        }),
      );
    }
    return plainCommand(
      `Staged ${staged.files.length} file(s) as \`${staged.id}\`. Send \`/import review ${staged.id}\` to read them into memory.`,
    );
  } catch (error) {
    if (error instanceof ImportFailure) return failure(error.code, json);
    throw error;
  }
}
