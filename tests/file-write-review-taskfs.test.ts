import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.js';

const sandbox = vi.hoisted(() => ({ copy: vi.fn() }));
vi.mock('../container/src/task-sandbox-files.js', () => ({
  copyTaskSandboxFileToTemp: sandbox.copy,
}));
const temporary = useTempDir('review-taskfs-');
useCleanMocks({ unstubAllEnvs: true, resetModules: true });
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');

beforeEach(() => {
  vi.stubEnv('HYBRIDCLAW_BASH_DOCKER_CONTAINER', 'fixture-task');
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_DISPLAY_ROOT', '/workspace');
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', temporary());
  sandbox.copy.mockReset();
});

test('revision review reads the task-container copy and removes it afterward', async () => {
  const tempDir = temporary();
  const localPath = path.join(tempDir, 'report.md');
  const content = '\ufeffGarden notes\r\nWater weekly.\r\n';
  fs.writeFileSync(localPath, content);
  sandbox.copy.mockReturnValue({ tempDir, localPath });
  const { readFileWriteReviewContent } = await import(
    '../container/src/file-write-review-content.js'
  );
  expect(readFileWriteReviewContent('report.md', hash(content))).toBe(content);
  expect(sandbox.copy).toHaveBeenCalledExactlyOnceWith('/workspace/report.md');
  expect(fs.existsSync(tempDir)).toBe(false);
});

test('a stale task-container copy is removed and never returned as reviewed content', async () => {
  const tempDir = temporary();
  const localPath = path.join(tempDir, 'report.md');
  fs.writeFileSync(localPath, 'Concurrent edit');
  sandbox.copy.mockReturnValue({ tempDir, localPath });
  const { readFileWriteReviewContent } = await import(
    '../container/src/file-write-review-content.js'
  );
  expect(() =>
    readFileWriteReviewContent('report.md', hash('Old revision')),
  ).toThrow(/stale/);
  expect(fs.existsSync(tempDir)).toBe(false);
});

test('a copied symlink cannot read host content even with a matching digest', async () => {
  const outside = temporary();
  const target = path.join(outside, 'private.txt');
  fs.writeFileSync(target, 'Private fixture');
  const tempDir = temporary();
  const localPath = path.join(tempDir, 'report.md');
  fs.symlinkSync(target, localPath);
  sandbox.copy.mockReturnValue({ tempDir, localPath });
  const { readFileWriteReviewContent } = await import(
    '../container/src/file-write-review-content.js'
  );
  expect(() =>
    readFileWriteReviewContent('report.md', hash('Private fixture')),
  ).toThrow(/regular file/);
  expect(fs.existsSync(tempDir)).toBe(false);
  expect(fs.readFileSync(target, 'utf8')).toBe('Private fixture');
});

test('host paths cannot be used as task-container review paths', async () => {
  const { readFileWriteReviewContent } = await import(
    '../container/src/file-write-review-content.js'
  );
  expect(() =>
    readFileWriteReviewContent('/private/host/report.md', hash('Data')),
  ).toThrow(/escapes/);
  expect(sandbox.copy).not.toHaveBeenCalled();
});
