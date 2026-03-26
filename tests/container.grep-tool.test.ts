import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

describe.sequential('container grep tool', () => {
  let workspaceRoot = '';

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    if (workspaceRoot) {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
      workspaceRoot = '';
    }
  });

  test('supports filename filters and context lines', async () => {
    workspaceRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-grep-workspace-'),
    );
    fs.mkdirSync(path.join(workspaceRoot, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(workspaceRoot, 'src', 'match.ts'),
      ['before', 'needle', 'after'].join('\n'),
    );
    fs.writeFileSync(
      path.join(workspaceRoot, 'notes.md'),
      ['before', 'needle', 'after'].join('\n'),
    );
    vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', workspaceRoot);

    const { executeTool } = await import('../container/src/tools.js');
    const result = await executeTool(
      'grep',
      JSON.stringify({
        pattern: 'needle',
        include: '*.ts',
        context: 1,
      }),
    );

    expect(result).toContain('src/match.ts:1:  before');
    expect(result).toContain('src/match.ts:2:> needle');
    expect(result).toContain('src/match.ts:3:  after');
    expect(result).not.toContain('notes.md');
  });

  test('skips noisy directories such as node_modules', async () => {
    workspaceRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-grep-workspace-'),
    );
    fs.mkdirSync(path.join(workspaceRoot, 'node_modules', 'pkg'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(workspaceRoot, 'node_modules', 'pkg', 'ignore.txt'),
      'needle',
    );
    vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', workspaceRoot);

    const { executeTool } = await import('../container/src/tools.js');
    const result = await executeTool(
      'grep',
      JSON.stringify({
        pattern: 'needle',
      }),
    );

    expect(result).toBe('No matches found.');
  });

  test('reports truncation when grep results hit the match cap', async () => {
    workspaceRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-grep-workspace-'),
    );
    const lines = Array.from({ length: 205 }, (_, index) => `needle ${index}`);
    fs.writeFileSync(path.join(workspaceRoot, 'matches.txt'), lines.join('\n'));
    vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', workspaceRoot);

    const { executeTool } = await import('../container/src/tools.js');
    const result = await executeTool(
      'grep',
      JSON.stringify({
        pattern: 'needle',
      }),
    );

    expect(result).toContain('matches.txt:1:> needle 0');
    expect(result).toContain('matches.txt:200:> needle 199');
    expect(result).not.toContain('matches.txt:205:> needle 204');
    expect(result).toContain('Results truncated due to match limit (200)');
  });
});
