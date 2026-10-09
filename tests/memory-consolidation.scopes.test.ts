import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import type { MemoryBackend } from '../src/memory/memory-service.js';
import { useTempDir } from './test-utils.js';

const makeTempDir = useTempDir('hybridclaw-scope-dream-');

afterEach(() => {
  vi.doUnmock('../src/agents/agent-registry.js');
  vi.doUnmock('../src/infra/ipc.js');
  vi.doUnmock('../src/logger.js');
  vi.resetModules();
});

const WORK = 's_0123456789ab';
const LINKED = 's_ba9876543210';

function write(root: string, relative: string, content: string): void {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf-8');
}

function read(root: string, relative: string): string {
  const file = path.join(root, relative);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '';
}

test('nightly consolidation keeps each scope in its own MEMORY.md', async () => {
  const workspace = makeTempDir();
  write(workspace, 'memory/2020-01-01.md', '- Main fact: the garden gate.\n');
  write(
    workspace,
    `scopes/${WORK}/memory/2020-01-02.md`,
    '- Work fact: the quarterly report.\n',
  );
  // A scope whose notes were swapped for a link to the agent's.
  fs.mkdirSync(path.join(workspace, 'scopes', LINKED), { recursive: true });
  fs.symlinkSync(
    path.join(workspace, 'memory'),
    path.join(workspace, 'scopes', LINKED, 'memory'),
  );
  vi.doMock('../src/agents/agent-registry.js', () => ({
    listAgents: vi.fn(() => [{ id: 'main' }]),
  }));
  vi.doMock('../src/infra/ipc.js', () => ({
    agentWorkspaceDir: vi.fn(() => workspace),
  }));
  vi.doMock('../src/logger.js', () => ({
    logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  }));
  const { MemoryConsolidationEngine } = await import(
    '../src/memory/memory-consolidation.js'
  );
  const backend = {
    decaySemanticMemories: vi.fn(() => 0),
  } as unknown as MemoryBackend;

  new MemoryConsolidationEngine(backend, {
    decayRate: 0.1,
    staleAfterDays: 7,
    minConfidence: 0.1,
  }).consolidate();

  expect(read(workspace, 'MEMORY.md')).toContain('the garden gate');
  expect(read(workspace, 'MEMORY.md')).not.toContain('quarterly report');
  const work = read(workspace, `scopes/${WORK}/MEMORY.md`);
  expect(work).toContain('the quarterly report');
  expect(work).not.toContain('garden gate');
  expect(read(workspace, `scopes/${LINKED}/MEMORY.md`)).not.toContain(
    'garden gate',
  );
});
