import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

describe.sequential('container glob tool', () => {
  let workspaceRoot = '';

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    if (workspaceRoot) {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
      workspaceRoot = '';
    }
  });

  test('returns actionable guidance for absolute paths outside the workspace', async () => {
    workspaceRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-glob-workspace-'),
    );
    vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', workspaceRoot);

    const { executeTool } = await import('../container/src/tools.js');
    const result = await executeTool(
      'glob',
      JSON.stringify({
        pattern: '/Users/example/OneDrive - Example/Buchhaltung/**/*.pdf',
      }),
    );

    expect(result).toContain('glob only searches inside the workspace');
    expect(result).toContain('use bash');
  });

  test('accepts host paths that are exposed through configured bind mounts', async () => {
    workspaceRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-glob-workspace-'),
    );
    const extraRoot = path.join(workspaceRoot, 'extra', 'buchhaltung');
    fs.mkdirSync(extraRoot, { recursive: true });
    fs.writeFileSync(path.join(extraRoot, 'invoice.pdf'), 'stub');
    vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', workspaceRoot);
    vi.stubEnv(
      'HYBRIDCLAW_AGENT_EXTRA_MOUNTS',
      JSON.stringify([
        {
          hostPaths: ['/Users/example/OneDrive - Example/Buchhaltung'],
          containerPath: path.join(workspaceRoot, 'extra', 'buchhaltung'),
          readonly: true,
        },
      ]),
    );

    const { executeTool } = await import('../container/src/tools.js');
    const result = await executeTool(
      'glob',
      JSON.stringify({
        pattern: '/Users/example/OneDrive - Example/Buchhaltung/**/*.pdf',
      }),
    );

    expect(result).toContain('extra/buchhaltung/invoice.pdf');
  });

  test('skips noisy directories such as node_modules', async () => {
    workspaceRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-glob-workspace-'),
    );
    fs.mkdirSync(path.join(workspaceRoot, 'src'), { recursive: true });
    fs.mkdirSync(path.join(workspaceRoot, 'node_modules', 'pkg'), {
      recursive: true,
    });
    fs.writeFileSync(path.join(workspaceRoot, 'src', 'keep.md'), 'keep');
    fs.writeFileSync(
      path.join(workspaceRoot, 'node_modules', 'pkg', 'ignore.md'),
      'ignore',
    );
    vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', workspaceRoot);

    const { executeTool } = await import('../container/src/tools.js');
    const result = await executeTool(
      'glob',
      JSON.stringify({
        pattern: '**/*.md',
      }),
    );

    expect(result).toContain('src/keep.md');
    expect(result).not.toContain('node_modules/pkg/ignore.md');
  });

  test('reports truncation when glob results hit the cap', async () => {
    workspaceRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-glob-workspace-'),
    );
    fs.mkdirSync(path.join(workspaceRoot, 'files'), { recursive: true });
    for (let index = 0; index < 55; index += 1) {
      fs.writeFileSync(
        path.join(
          workspaceRoot,
          'files',
          `result-${String(index).padStart(2, '0')}.txt`,
        ),
        'stub',
      );
    }
    vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', workspaceRoot);

    const { executeTool } = await import('../container/src/tools.js');
    const result = await executeTool(
      'glob',
      JSON.stringify({
        pattern: 'files/*.txt',
      }),
    );

    expect(result).toContain('files/result-00.txt');
    expect(result).toContain('files/result-49.txt');
    expect(result).not.toContain('files/result-54.txt');
    expect(result).toContain('Results truncated due to result limit (50)');
  });
});
