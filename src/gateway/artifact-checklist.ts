/**
 * Checklist ticks — `POST /api/artifact/checklist` sets one GitHub task-list
 * item (`- [ ] Moos`) in a Markdown file the agent wrote, so a tick on a phone
 * lands in the file itself and the agent, the Library and other phones see it.
 *
 * Only the item's mark changes: every other byte, line endings included, stays
 * as it was, and the item is named by its number and title together, so a tick
 * against a list that changed since the client read it is refused (409) with
 * the current text instead of hitting the wrong line.
 *
 * NOT a file editor and NOT `GET /api/artifact`: it reads and writes only
 * `.md` files in the agent workspaces, never the upload or Discord media
 * caches, and it cannot add, remove or rename items (the agent does that).
 */
import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { writeMemoryFileAtomic } from '../../container/shared/memory-file.js';
import { DATA_DIR } from '../config/config.js';
import { GatewayRequestError } from '../errors/gateway-request-error.js';
import { isRecord } from '../utils/type-guards.js';
import { readJsonBody, sendJson } from './gateway-http-utils.js';

export const ARTIFACT_CHECKLIST_PATH = '/api/artifact/checklist';

// A shopping or packing list is a few KB; this keeps a tick cheap.
const MAX_CHECKLIST_FILE_BYTES = 256 * 1024;

// The numbering rule, which the iOS and Android apps implement identically:
// split the file at "\n" (a "\r" before it stays part of the line); a line
// whose trimmed text starts with ``` opens or closes a code fence; outside
// fences, item N is the N-th (0-based) line matching ITEM_LINE_RE. Its mark is
// the character after the first "[", and its title is the text after the
// "]" that follows, trimmed.
const ITEM_LINE_RE = /^[ \t]*[-*+] \[[ xX]\][ \t]+\S/;
const FENCE_PREFIX = '```';

export type ChecklistUpdate =
  | { ok: true; content: string }
  | { ok: false; error: string; content: string };

/** Sets item `item` to done or not done if its title still is `title`. */
export function setChecklistItem(
  content: string,
  item: number,
  title: string,
  done: boolean,
): ChecklistUpdate {
  const lines = content.split('\n');
  let inFence = false;
  let index = 0;
  for (let lineNo = 0; lineNo < lines.length; lineNo += 1) {
    const line = lines[lineNo];
    if (line.trim().startsWith(FENCE_PREFIX)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || !ITEM_LINE_RE.test(line)) continue;
    if (index !== item) {
      index += 1;
      continue;
    }
    const markAt = line.indexOf('[') + 1;
    if (line.slice(markAt + 2).trim() !== title) {
      return {
        ok: false,
        error: `Item ${item} is no longer that item.`,
        content,
      };
    }
    lines[lineNo] =
      `${line.slice(0, markAt)}${done ? 'x' : ' '}${line.slice(markAt + 1)}`;
    return { ok: true, content: lines.join('\n') };
  }
  return { ok: false, error: `The list has no item ${item}.`, content };
}

async function realpathOrResolve(filePath: string): Promise<string> {
  try {
    return await fs.promises.realpath(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

/**
 * The file `GET /api/artifact?path=` would serve for `rawPath`, if it is a
 * Markdown file inside the agent workspaces; null otherwise.
 */
async function resolveChecklistFile(rawPath: string): Promise<string | null> {
  const trimmed = rawPath.trim();
  if (!trimmed) return null;
  let realFilePath: string;
  try {
    realFilePath = await fs.promises.realpath(path.resolve(trimmed));
  } catch {
    return null;
  }
  const root = await realpathOrResolve(path.join(DATA_DIR, 'agents'));
  if (!realFilePath.startsWith(`${root}${path.sep}`)) return null;
  if (path.extname(realFilePath).toLowerCase() !== '.md') return null;
  return realFilePath;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

/**
 * Reads, edits and writes the file in one synchronous step, so two ticks in
 * this process never interleave and neither overwrites the other's.
 */
function updateChecklistFile(
  filePath: string,
  item: number,
  title: string,
  done: boolean,
): ChecklistUpdate | null {
  let bytes: Buffer;
  try {
    const stats = fs.statSync(filePath);
    if (!stats.isFile()) return null;
    if (stats.size > MAX_CHECKLIST_FILE_BYTES) {
      throw new GatewayRequestError(413, 'Checklist file too large.');
    }
    bytes = fs.readFileSync(filePath);
  } catch (error) {
    if (error instanceof GatewayRequestError) throw error;
    return null;
  }
  let content: string;
  try {
    // Not valid UTF-8 means not a list the apps wrote or can show.
    content = utf8.decode(bytes);
  } catch {
    return null;
  }
  const update = setChecklistItem(content, item, title, done);
  if (update.ok && update.content !== content) {
    writeMemoryFileAtomic(filePath, update.content);
  }
  return update;
}

export async function handleArtifactChecklistRoute(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = await readJsonBody(req);
  if (
    !isRecord(body) ||
    typeof body.path !== 'string' ||
    !Number.isSafeInteger(body.item) ||
    (body.item as number) < 0 ||
    typeof body.title !== 'string' ||
    typeof body.done !== 'boolean'
  ) {
    throw new GatewayRequestError(
      400,
      'Expected `path`, `item` (a whole number from 0), `title` and `done`.',
    );
  }
  const filePath = await resolveChecklistFile(body.path);
  const update = filePath
    ? updateChecklistFile(filePath, body.item as number, body.title, body.done)
    : null;
  if (!update) {
    sendJson(res, 404, { error: 'Checklist not found.' });
    return;
  }
  if (!update.ok) {
    sendJson(res, 409, { error: update.error, content: update.content });
    return;
  }
  sendJson(res, 200, { content: update.content });
}
