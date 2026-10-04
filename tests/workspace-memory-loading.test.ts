import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { agentWorkspaceDir } from '../src/infra/ipc.js';
import { truncateHeadTailText } from '../src/session/token-efficiency.js';
import {
  loadStaticBootstrapFiles,
  WORKSPACE_CONTEXT_FILE_MAX_CHARS,
} from '../src/workspace.js';
import { useCleanMocks, useTempDir } from './test-utils.js';

vi.mock('../src/infra/ipc.js', () => ({ agentWorkspaceDir: vi.fn() }));

const makeTempDir = useTempDir('workspace-memory-');
useCleanMocks({ restoreAllMocks: true });

test.each(['x', '界', '😀'])(
  'bounds oversized memory reads and preserves both ends (%s)',
  (character) => {
    const directory = makeTempDir();
    vi.mocked(agentWorkspaceDir).mockReturnValue(directory);
    const content = `Beginning\n${character.repeat(1_000_000)}\nLatest memory.`;
    fs.writeFileSync(path.join(directory, 'MEMORY.md'), content);
    const read = vi.spyOn(fs, 'readSync');

    const memory = loadStaticBootstrapFiles('agent_a').find(
      (file) => file.name === 'MEMORY.md',
    );

    expect(memory?.content).toBe(
      truncateHeadTailText(content, WORKSPACE_CONTEXT_FILE_MAX_CHARS),
    );
    expect(memory?.content).not.toContain('\uFFFD');
    const bytesRead = read.mock.results.reduce(
      (sum, result) => sum + Number(result.value),
      0,
    );
    expect(bytesRead).toBeLessThanOrEqual(WORKSPACE_CONTEXT_FILE_MAX_CHARS * 8);
  },
);

test('loads current memory after replacement or deletion without a stale cache', () => {
  const directory = makeTempDir();
  vi.mocked(agentWorkspaceDir).mockReturnValue(directory);
  const file = path.join(directory, 'MEMORY.md');
  const load = () =>
    loadStaticBootstrapFiles('agent_a').find((entry) => entry.name === 'MEMORY.md')
      ?.content;

  fs.writeFileSync(file, 'First memory');
  expect(load()).toBe('First memory');
  fs.writeFileSync(`${file}.tmp`, 'Updated memory');
  fs.renameSync(`${file}.tmp`, file);
  expect(load()).toBe('Updated memory');
  fs.unlinkSync(file);
  expect(load()).toBeUndefined();
});

test('unreadable memory does not prevent other bootstrap context from loading', () => {
  const directory = makeTempDir();
  vi.mocked(agentWorkspaceDir).mockReturnValue(directory);
  fs.mkdirSync(path.join(directory, 'MEMORY.md'));
  fs.writeFileSync(path.join(directory, 'SOUL.md'), 'Workspace identity');

  expect(loadStaticBootstrapFiles('agent_a')).toEqual([
    { name: 'SOUL.md', content: 'Workspace identity' },
  ]);
});
