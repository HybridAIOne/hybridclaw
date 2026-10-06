/**
 * Dream journals preserve readable history of committed MEMORY.md changes.
 * Callers hold the MEMORY.md lock, so entries for a workspace append serially.
 * Unlike durable memory, this history is not injected into prompts or recalled
 * as current truth; it does not generate interpretations with another model.
 */
import fs from 'node:fs';
import path from 'node:path';

import { currentDateStampInTimezone } from '../../container/shared/workspace-time.js';
import { logger } from '../logger.js';

const CLEANUP_METHODS = {
  model: 'Model cleanup',
  deterministic: 'Deterministic consolidation',
  fallback: 'Deterministic fallback after model cleanup failed',
};

export function appendDreamJournal(params: {
  workspaceDir: string;
  timezone?: string;
  before: string;
  after: string;
  sourceDates: string[];
  method: keyof typeof CLEANUP_METHODS;
}): void {
  if (params.before === params.after) return;

  const now = new Date();
  const date = currentDateStampInTimezone(params.timezone, now);
  const journalPath = path.join(params.workspaceDir, 'dreams', `${date}.md`);
  const beforeLines = params.before.replace(/\r\n/g, '\n').split('\n');
  const afterLines = params.after.replace(/\r\n/g, '\n').split('\n');
  const beforeSet = new Set(beforeLines);
  const afterSet = new Set(afterLines);
  const added = afterLines.filter(
    (line) => line.trim() && !beforeSet.has(line),
  );
  const removed = beforeLines.filter(
    (line) => line.trim() && !afterSet.has(line),
  );
  const entry = [
    `## ${now.toISOString()}`,
    '',
    `${CLEANUP_METHODS[params.method]}. Reviewed ${params.sourceDates.length} older daily note(s).`,
    '',
    '### Sources',
    '',
    '[Durable memory](../MEMORY.md)',
    ...params.sourceDates.map(
      (sourceDate) => `- [${sourceDate}](../memory/${sourceDate}.md)`,
    ),
    '',
    '### Added to memory',
    '',
    ...(added.length ? added.map((line) => `> ${line}`) : ['No new lines.']),
    '',
    '### Removed from memory',
    '',
    ...(removed.length
      ? removed.map((line) => `> ${line}`)
      : ['No removed lines.']),
    '',
  ].join('\n');

  try {
    fs.mkdirSync(path.dirname(journalPath), { recursive: true });
    if (!fs.lstatSync(path.dirname(journalPath)).isDirectory()) {
      throw new Error('Dream journal directory must not be a symlink.');
    }
    const fd = fs.openSync(
      journalPath,
      fs.constants.O_WRONLY |
        fs.constants.O_APPEND |
        fs.constants.O_CREAT |
        fs.constants.O_NOFOLLOW |
        fs.constants.O_NONBLOCK,
      0o600,
    );
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1) {
        throw new Error('Dream journal must be a regular file with one link.');
      }
      const prefix = stat.size === 0 ? `# Dream journal — ${date}\n` : '';
      fs.writeFileSync(fd, `${prefix}\n${entry}`, 'utf-8');
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    logger.warn(
      { workspaceDir: params.workspaceDir, journalPath, err },
      'Memory updated but dream journal could not be written',
    );
  }
}
