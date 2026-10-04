import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, test, vi } from 'vitest';

import { appendDreamJournal } from '../src/memory/dream-journal.js';
import { useCleanMocks, useTempDir } from './test-utils.js';

vi.mock('../src/logger.js', () => ({ logger: { warn: vi.fn() } }));

describe('dream journal', () => {
  const makeTempDir = useTempDir();
  useCleanMocks({ restoreAllMocks: true, cleanup: () => vi.useRealTimers() });

  test('appends changes on the workspace date and keeps earlier entries', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-07T00:30:00.000Z'));
    const workspaceDir = makeTempDir();
    const params = {
      workspaceDir,
      timezone: 'America/Los_Angeles',
      before: '# Memory\r\n\r\n## Facts\r\n- Old fact.\r\n- Kept fact.\r\n',
      after: '# Memory\n\n## Facts\n- New fact.\n- Kept fact.\n',
      sourceDates: ['2026-04-05'],
      method: 'model' as const,
    };
    appendDreamJournal(params);
    const journalPath = path.join(workspaceDir, 'dreams', '2026-04-06.md');
    const first = fs.readFileSync(journalPath, 'utf8');
    expect(first).toContain('## 2026-04-07T00:30:00.000Z');
    expect(first).toContain('[2026-04-05](../memory/2026-04-05.md)');
    expect(first).toContain('> - New fact.');
    expect(first).toContain('> - Old fact.');
    expect(first).not.toContain('Kept fact.');
    expect(first).not.toContain('> # Memory');
    expect(fs.statSync(journalPath).mode & 0o777).toBe(0o600);

    appendDreamJournal({ ...params, before: params.after, after: '- Latest fact.\n' });
    const second = fs.readFileSync(journalPath, 'utf8');
    expect(second.startsWith(first)).toBe(true);
    expect(second.match(/^# /gm)).toHaveLength(1);
    expect(second.match(/^## /gm)).toHaveLength(2);
    expect(second).toContain('> - Latest fact.');

    vi.setSystemTime(new Date('2026-04-08T00:30:00.000Z'));
    appendDreamJournal(params);
    expect(fs.readdirSync(path.dirname(journalPath))).toEqual([
      '2026-04-06.md',
      '2026-04-07.md',
    ]);
  });

  test('does not create a journal for an unchanged document', () => {
    const workspaceDir = makeTempDir();
    appendDreamJournal({ workspaceDir, before: '- Fact.\n', after: '- Fact.\n', sourceDates: [], method: 'model' });
    expect(fs.existsSync(path.join(workspaceDir, 'dreams'))).toBe(false);
  });

  test.each(['directory symlink', 'file symlink', 'file hard link'])(
    'rejects a %s without modifying its target',
    async (target) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-04-07T12:00:00.000Z'));
      const workspaceDir = makeTempDir();
      const outsideDir = makeTempDir();
      const outsideFile = path.join(outsideDir, '2026-04-07.md');
      fs.writeFileSync(outsideFile, 'Untouched.\n');
      const journalDir = path.join(workspaceDir, 'dreams');
      if (target === 'directory symlink') {
        fs.symlinkSync(outsideDir, journalDir, 'dir');
      } else {
        fs.mkdirSync(journalDir);
        const journalPath = path.join(journalDir, '2026-04-07.md');
        if (target === 'file symlink') fs.symlinkSync(outsideFile, journalPath);
        else fs.linkSync(outsideFile, journalPath);
      }
      appendDreamJournal({ workspaceDir, timezone: 'UTC', before: '- Old.\n', after: '- New.\n', sourceDates: [], method: 'model' });
      expect(fs.readFileSync(outsideFile, 'utf8')).toBe('Untouched.\n');
      const { logger } = await import('../src/logger.js');
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(expect.objectContaining({ workspaceDir, err: expect.any(Error) }), expect.stringContaining('dream journal'));
    },
  );
});
