import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { DAILY_MEMORY_MAX_CHARS, readDailyMemoryFile, truncateDailyMemoryText } from '../container/shared/daily-memory.js';
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
function writeNote(content: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-memory-'));
  directories.push(directory);
  const file = path.join(directory, 'note.md');
  fs.writeFileSync(file, content);
  return file;
}
test('reads the entire valid note in characters, including multibyte text', () => {
  const text = '界'.repeat(DAILY_MEMORY_MAX_CHARS - 8) + '\nLatest.';
  expect(readDailyMemoryFile(writeNote(text))).toBe(text);
});
test('oversized external notes retain their head and appended tail within the cap', () => {
  const text = 'Beginning\n' + '😀'.repeat(70_000) + '\nLatest note.';
  const content = readDailyMemoryFile(writeNote(text));
  expect(content?.length).toBeLessThanOrEqual(DAILY_MEMORY_MAX_CHARS);
  expect(content).toContain('Beginning');
  expect(content).toContain('Latest note.');
  expect(content).toContain('[truncated middle]');
  expect(content).not.toContain('\uFFFD');
});
test('small truncation budgets remain bounded', () => {
  for (let budget = 0; budget < 30; budget++) expect(truncateDailyMemoryText('x'.repeat(100), budget).length).toBeLessThanOrEqual(budget);
});
