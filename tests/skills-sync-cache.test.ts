import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { loadIsolatedSkillsRuntime } from './helpers/skills-workspace-runtime.ts';
import { useCleanMocks, useTempDir } from './test-utils.ts';

const makeTempDir = useTempDir('hybridclaw-skills-sync-cache-');
useCleanMocks({
  restoreAllMocks: true,
  resetModules: true,
  unstubAllEnvs: true,
  unmock: ['../src/infra/install-root.js'],
});

function skillMarkdown(body: string): string {
  return `---\nname: alpha\ndescription: Test skill\n---\n\n${body}\n`;
}

// Fixed before any test mocks the clock, so a stamp only changes where a test
// changes it.
const START = Date.now();

function setMtimeSecondsAgo(file: string, seconds: number): void {
  const time = new Date(START - seconds * 1_000);
  fs.utimesSync(file, time, time);
}

// The hash runs on a later turn, past the window in which a fresh stamp is
// not trusted yet.
function moveClockToLaterTurn(): void {
  vi.spyOn(Date, 'now').mockReturnValue(START + 60_000);
}

function writeSkillDir(): { dir: string; skillFile: string } {
  const dir = makeTempDir();
  const skillFile = path.join(dir, 'SKILL.md');
  fs.writeFileSync(skillFile, skillMarkdown('Body one.'));
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.writeFileSync(path.join(dir, 'scripts', 'run.sh'), 'echo one\n');
  setMtimeSecondsAgo(skillFile, 120);
  return { dir, skillFile };
}

async function importSyncCache() {
  return import('../src/skills/skills-sync-cache.ts');
}

test('stats but does not re-read skill files that did not change', async () => {
  const { dir } = writeSkillDir();
  moveClockToLaterTurn();
  const { buildDirectoryContentSignature } = await importSyncCache();
  const first = buildDirectoryContentSignature(dir);

  const readSpy = vi.spyOn(fs, 'readFileSync');
  expect(buildDirectoryContentSignature(dir)).toBe(first);
  expect(readSpy).not.toHaveBeenCalled();
});

test.each([
  { change: 'size', body: 'Body number two.', secondsAgo: 120 },
  { change: 'mtime at the same size', body: 'Body two.', secondsAgo: 90 },
])(
  're-hashes a skill file whose $change changed',
  async ({ body, secondsAgo }) => {
    const { dir, skillFile } = writeSkillDir();
    moveClockToLaterTurn();
    const { buildDirectoryContentSignature } = await importSyncCache();
    const first = buildDirectoryContentSignature(dir);

    fs.writeFileSync(skillFile, skillMarkdown(body));
    setMtimeSecondsAgo(skillFile, secondsAgo);
    const readSpy = vi.spyOn(fs, 'readFileSync');
    expect(buildDirectoryContentSignature(dir)).not.toBe(first);
    expect(readSpy).toHaveBeenCalledWith(skillFile);
  },
);

test('re-reads a file written within the last two seconds', async () => {
  const { dir } = writeSkillDir();
  const freshFile = path.join(dir, 'scripts', 'run.sh');
  const { buildDirectoryContentSignature } = await importSyncCache();
  buildDirectoryContentSignature(dir);

  const readSpy = vi.spyOn(fs, 'readFileSync');
  buildDirectoryContentSignature(dir);
  expect(readSpy).toHaveBeenCalledWith(freshFile);
});

test('loadSkills syncs an edited source SKILL.md on the next turn', async () => {
  const { skills, bundledDir, workspaceDir } = await loadIsolatedSkillsRuntime(
    makeTempDir(),
  );
  const sourceFile = path.join(bundledDir, 'alpha', 'SKILL.md');
  fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
  fs.writeFileSync(sourceFile, skillMarkdown('Body one.'));
  setMtimeSecondsAgo(sourceFile, 120);
  moveClockToLaterTurn();
  skills.loadSkills('main');
  skills.loadSkills('main');

  fs.writeFileSync(sourceFile, skillMarkdown('Body two.'));
  setMtimeSecondsAgo(sourceFile, 90);
  skills.loadSkills('main');

  const syncedFile = path.join(workspaceDir, 'skills', 'alpha', 'SKILL.md');
  expect(fs.readFileSync(syncedFile, 'utf-8')).toBe(skillMarkdown('Body two.'));
});
