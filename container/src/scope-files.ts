/**
 * The scopes' memory files and transcripts as the main chat's searches see
 * them, workspace-relative (`scopes/<id>/MEMORY.md`). A scoped chat's
 * workspace is its scope's own directory and has no `scopes/`, so there these
 * lists are empty: only the main chat (and unscoped chats) search every scope.
 *
 * NOT `memory` reads or writes, which stay on the chat's own files.
 */
import fs from 'node:fs';
import { listScopeDirNamesIn, SCOPES_DIRNAME } from '../shared/scope-dirs.js';

const DAILY_NOTE_RE = /^\d{4}-\d{2}-\d{2}\.md$/;

/** `join` resolves a workspace-relative path inside the workspace. */
export function scopeMemoryFiles(join: (relative: string) => string): string[] {
  const files: string[] = [];
  for (const id of listScopeDirNamesIn(join(SCOPES_DIRNAME))) {
    const root = `${SCOPES_DIRNAME}/${id}`;
    if (fs.existsSync(join(`${root}/MEMORY.md`))) {
      files.push(`${root}/MEMORY.md`);
    }
    let notes: string[] = [];
    try {
      notes = fs.readdirSync(join(`${root}/memory`));
    } catch {
      notes = [];
    }
    for (const name of notes
      .filter((note) => DAILY_NOTE_RE.test(note))
      .sort()) {
      files.push(`${root}/memory/${name}`);
    }
  }
  return files;
}

export function scopeTranscriptDirs(
  join: (relative: string) => string,
  transcriptsDirname: string,
): string[] {
  return listScopeDirNamesIn(join(SCOPES_DIRNAME)).map(
    (id) => `${SCOPES_DIRNAME}/${id}/${transcriptsDirname}`,
  );
}
