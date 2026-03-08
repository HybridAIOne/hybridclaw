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
});
