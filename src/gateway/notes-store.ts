/**
 * Shared notebook pages live in one agent workspace as Markdown plus a tree index.
 * IDs survive renames and moves; revision checks and a cooperative lock prevent
 * stale app/model saves. This is user-visible content, not canonical memory.
 */
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  lockMemoryFile,
  writeMemoryFileAtomic,
} from '../../container/shared/memory-file.js';
import { GatewayRequestError } from '../errors/gateway-request-error.js';
import { isRecord } from '../utils/type-guards.js';
import {
  MAX_MARKDOWN_BYTES,
  readSystemFile,
  readSystemMarkdown,
  updateSystemMarkdown,
} from './system-files.js';

export interface NotePage {
  id: string;
  title: string;
  parentId: string | null;
  archived: boolean;
}
interface NoteIndex {
  version: 1;
  pages: NotePage[];
}
const INDEX_PATH = 'notes/index.json';
// Product scope, 2026-10-07: a personal notebook, bounded to keep tree reads cheap.
const MAX_PAGES = 1000;
const MAX_HISTORY = 50;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
export function validNoteId(id: unknown): id is string {
  return (
    typeof id === 'string' &&
    (id === 'scratchpad' ||
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
        id,
      ))
  );
}
function fail(status: number, message: string): never {
  throw new GatewayRequestError(status, message);
}
function title(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.trim().length > 200 ||
    /[\r\n\0]/.test(value)
  )
    fail(400, 'Expected a page title.');
  return value.trim();
}
function content(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.includes('\0') ||
    Buffer.from(value).toString('utf8') !== value
  )
    fail(400, 'Expected Markdown text.');
  if (Buffer.byteLength(value) > MAX_MARKDOWN_BYTES)
    fail(413, 'Page exceeds 1 MB.');
  return value;
}
function directory(root: string, relative: string): string {
  let target = fs.realpathSync(root);
  for (const part of relative.split('/')) {
    target = path.join(target, part);
    try {
      fs.mkdirSync(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    if (
      !fs.lstatSync(target).isDirectory() ||
      fs.realpathSync(target) !== target
    )
      fail(403, 'Notes directories must be regular directories.');
  }
  return target;
}
function readIndex(root: string): { index: NoteIndex; revision: string } {
  let text: string;
  try {
    text = new TextDecoder('utf8', { fatal: true }).decode(
      readSystemFile(root, INDEX_PATH, MAX_MARKDOWN_BYTES),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return { index: { version: 1, pages: [] }, revision: hash('') };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    fail(409, 'Invalid notebook index.');
  }
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !Array.isArray(value.pages) ||
    value.pages.length > MAX_PAGES
  )
    fail(409, 'Invalid notebook index.');
  const pages: NotePage[] = value.pages.map((page: unknown) => {
    if (
      !isRecord(page) ||
      !validNoteId(page.id) ||
      typeof page.title !== 'string' ||
      title(page.title) !== page.title ||
      !(page.parentId === null || validNoteId(page.parentId)) ||
      typeof page.archived !== 'boolean'
    )
      fail(409, 'Invalid notebook page.');
    return {
      id: page.id,
      title: page.title,
      parentId: page.parentId,
      archived: page.archived,
    };
  });
  if (new Set(pages.map((p) => p.id)).size !== pages.length)
    fail(409, 'Duplicate notebook pages.');
  for (const page of pages) {
    const seen = new Set([page.id]);
    let parent = page.parentId;
    while (parent !== null) {
      if (seen.has(parent)) fail(409, 'Notebook contains a cycle.');
      seen.add(parent);
      const ancestor = pages.find((p) => p.id === parent);
      if (!ancestor || (!page.archived && ancestor.archived))
        fail(409, 'Notebook parent is unavailable.');
      parent = ancestor.parentId;
    }
  }
  return { index: { version: 1, pages }, revision: hash(text) };
}
function find(index: NoteIndex, id: unknown): NotePage {
  if (!validNoteId(id)) fail(400, 'Expected a page ID.');
  const page = index.pages.find((p) => p.id === id);
  if (!page) fail(404, 'Page not found.');
  return page;
}
export function listNotes(root: string) {
  const { index, revision } = readIndex(root);
  return { pages: index.pages, revision };
}
export function readNote(root: string, id: unknown, revision?: string) {
  const page = find(readIndex(root).index, id);
  if (revision && !/^[a-f0-9]{64}$/.test(revision))
    fail(400, 'Expected a revision.');
  const relative = revision
    ? `notes/history/${page.id}/${revision}.md`
    : `notes/pages/${page.id}.md`;
  const file = readSystemMarkdown(root, relative);
  if (revision && file.revision !== revision)
    fail(409, 'Earlier version changed.');
  const history = listHistory(root, page.id);
  return { page, content: file.content, revision: file.revision, history };
}
function listHistory(
  root: string,
  id: string,
): { revision: string; savedAt: string }[] {
  try {
    const relative = `notes/history/${id}`;
    // Reading through systemFiles validates all ancestors and excludes symlinks.
    const folder = path.join(fs.realpathSync(root), relative);
    for (const part of ['notes', 'history', id]) {
      const current =
        part === 'notes'
          ? path.join(fs.realpathSync(root), part)
          : part === 'history'
            ? path.join(fs.realpathSync(root), 'notes', part)
            : folder;
      if (
        !fs.lstatSync(current).isDirectory() ||
        fs.realpathSync(current) !== current
      )
        fail(403, 'Invalid history directory.');
    }
    return fs
      .readdirSync(folder)
      .filter((name) => /^[a-f0-9]{64}\.md$/.test(name))
      .map((name) => {
        const file = path.join(folder, name);
        if (!fs.lstatSync(file).isFile()) fail(403, 'Invalid history file.');
        return {
          revision: name.slice(0, -3),
          savedAt: fs.statSync(file).mtime.toISOString(),
        };
      })
      .sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}
function requireRevision(actual: string, given: unknown): void {
  if (typeof given !== 'string' || !/^[a-f0-9]{64}$/.test(given))
    fail(400, 'Expected a revision.');
  if (actual !== given)
    fail(409, 'The notebook changed. Reload before saving.');
}
function parent(index: NoteIndex, value: unknown): string | null {
  if (value === null) return null;
  const page = find(index, value);
  if (page.archived) fail(409, 'Parent page is archived.');
  return page.id;
}
export function changeNotes(root: string, body: unknown) {
  if (!isRecord(body) || typeof body.operation !== 'string')
    fail(400, 'Expected a notebook operation.');
  const folder = directory(root, 'notes');
  const indexPath = path.join(folder, 'index.json');
  if (fs.existsSync(indexPath) && !fs.lstatSync(indexPath).isFile())
    fail(403, 'Invalid notebook index.');
  let release: () => void;
  try {
    release = lockMemoryFile(indexPath);
  } catch {
    fail(409, 'Notebook is busy. Try again.');
  }
  try {
    const { index, revision } = readIndex(root);
    if (body.operation === 'save') {
      const page = find(index, body.id);
      if (page.archived) fail(409, 'Page is archived.');
      const current = readNote(root, page.id);
      requireRevision(current.revision, body.revision);
      const next = content(body.content);
      if (next !== current.content) {
        const historyFolder = directory(root, `notes/history/${page.id}`);
        const previous = path.join(historyFolder, `${current.revision}.md`);
        if (!fs.existsSync(previous))
          fs.writeFileSync(previous, current.content, {
            flag: 'wx',
            mode: 0o600,
          });
        else if (!fs.lstatSync(previous).isFile())
          fail(403, 'Invalid history file.');
        updateSystemMarkdown(
          root,
          `notes/pages/${page.id}.md`,
          current.revision,
          next,
        );
        for (const old of listHistory(root, page.id).slice(MAX_HISTORY))
          fs.unlinkSync(path.join(historyFolder, `${old.revision}.md`));
      }
      return readNote(root, page.id);
    }
    requireRevision(revision, body.revision);
    let changed: NotePage;
    if (body.operation === 'create' || body.operation === 'scratchpad') {
      if (
        body.operation === 'scratchpad' &&
        index.pages.some((p) => p.id === 'scratchpad')
      )
        return listNotes(root);
      if (index.pages.length >= MAX_PAGES)
        fail(413, 'Notebook has too many pages.');
      changed = {
        id: body.operation === 'scratchpad' ? 'scratchpad' : randomUUID(),
        title: title(body.title),
        parentId: parent(index, body.parentId ?? null),
        archived: false,
      };
      const text = content(body.content ?? '');
      const pagesFolder = directory(root, 'notes/pages');
      const filename = path.join(pagesFolder, `${changed.id}.md`);
      if (changed.id === 'scratchpad' && fs.existsSync(filename)) {
        readSystemMarkdown(root, `notes/pages/${changed.id}.md`);
      } else {
        fs.writeFileSync(filename, text, { flag: 'wx', mode: 0o600 });
      }
      index.pages.push(changed);
    } else {
      changed = find(index, body.id);
      if (body.operation === 'rename') changed.title = title(body.title);
      else if (body.operation === 'move') {
        const nextParent = parent(index, body.parentId);
        let ancestor = nextParent;
        while (ancestor !== null) {
          if (ancestor === changed.id)
            fail(400, 'A page cannot contain itself.');
          ancestor = find(index, ancestor).parentId;
        }
        if (
          !Number.isSafeInteger(body.position) ||
          (body.position as number) < 0
        )
          fail(400, 'Expected a page position.');
        index.pages = index.pages.filter((p) => p.id !== changed.id);
        changed.parentId = nextParent;
        const siblings = index.pages.filter((p) => p.parentId === nextParent);
        const sibling = siblings[body.position as number];
        const at = sibling ? index.pages.indexOf(sibling) : index.pages.length;
        index.pages.splice(at, 0, changed);
      } else if (
        body.operation === 'archive' ||
        body.operation === 'unarchive'
      ) {
        const archived = body.operation === 'archive';
        if (
          !archived &&
          changed.parentId !== null &&
          find(index, changed.parentId).archived
        )
          fail(409, 'Restore the parent page first.');
        for (const page of index.pages) {
          let ancestor: string | null = page.id;
          while (ancestor !== null) {
            if (ancestor === changed.id) {
              page.archived = archived;
              break;
            }
            ancestor = find(index, ancestor).parentId;
          }
        }
      } else fail(400, 'Unknown notebook operation.');
    }
    if (readIndex(root).revision !== revision)
      fail(409, 'Notebook changed while saving.');
    writeMemoryFileAtomic(indexPath, `${JSON.stringify(index, null, 2)}\n`);
    return listNotes(root);
  } finally {
    release();
  }
}
