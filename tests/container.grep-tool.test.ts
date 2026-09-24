import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

describe.sequential('container grep tool', () => {
  let workspaceRoot = '';

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.doUnmock('node:child_process');
    vi.resetModules();
    if (workspaceRoot) {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
      workspaceRoot = '';
    }
  });

  function createWorkspaceWithEnvFiles(): void {
    workspaceRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-grep-workspace-'),
    );
    fs.mkdirSync(path.join(workspaceRoot, 'src'), { recursive: true });
    fs.mkdirSync(path.join(workspaceRoot, 'config'), { recursive: true });
    fs.writeFileSync(path.join(workspaceRoot, '.env'), 'API_KEY=test-key-root');
    fs.writeFileSync(
      path.join(workspaceRoot, '.env.local'),
      'API_KEY=test-key-local',
    );
    fs.writeFileSync(
      path.join(workspaceRoot, 'config', '.env.production'),
      'API_KEY=test-key-prod',
    );
    fs.writeFileSync(
      path.join(workspaceRoot, 'src', 'app.ts'),
      'const key = process.env.API_KEY;',
    );
    vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', workspaceRoot);
  }

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

  test('treats patterns as fixed strings by default', async () => {
    workspaceRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-grep-workspace-'),
    );
    fs.writeFileSync(
      path.join(workspaceRoot, 'literal.txt'),
      ['needle.1', 'needleX1'].join('\n'),
    );
    vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', workspaceRoot);

    const { executeTool } = await import('../container/src/tools.js');
    const result = await executeTool(
      'grep',
      JSON.stringify({
        pattern: 'needle.1',
      }),
    );

    expect(result).toContain('literal.txt:1:> needle.1');
    expect(result).not.toContain('literal.txt:2:> needleX1');
  });

  test('supports opt-in regex mode for safe patterns', async () => {
    workspaceRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-grep-workspace-'),
    );
    fs.writeFileSync(
      path.join(workspaceRoot, 'regex.txt'),
      ['needle123', 'needleabc'].join('\n'),
    );
    vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', workspaceRoot);

    const { executeTool } = await import('../container/src/tools.js');
    const result = await executeTool(
      'grep',
      JSON.stringify({
        pattern: 'needle\\d+',
        regex: true,
      }),
    );

    expect(result).toContain('regex.txt:1:> needle123');
    expect(result).not.toContain('regex.txt:2:> needleabc');
  });

  test('rejects unsafe regex patterns in regex mode', async () => {
    workspaceRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-grep-workspace-'),
    );
    fs.writeFileSync(path.join(workspaceRoot, 'regex.txt'), 'needle');
    vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', workspaceRoot);

    const { executeTool } = await import('../container/src/tools.js');
    const result = await executeTool(
      'grep',
      JSON.stringify({
        pattern: '(a+)+$',
        regex: true,
      }),
    );

    expect(result).toContain('Error: nested quantifiers are not supported');
  });

  test('skips oversized text files without matching their contents', async () => {
    workspaceRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-grep-workspace-'),
    );
    const oversized = Buffer.alloc(2 * 1024 * 1024 + 1, 'a');
    Buffer.from('needle').copy(oversized, oversized.length - 'needle'.length);
    fs.writeFileSync(path.join(workspaceRoot, 'large.txt'), oversized);
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

  test('uses one shared timeout budget across file discovery and matching', async () => {
    workspaceRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-grep-workspace-'),
    );
    fs.writeFileSync(path.join(workspaceRoot, 'match.txt'), 'needle');
    vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', workspaceRoot);

    const nowValues = [0, 29_999, 29_999, 30_000];
    let lastNow = nowValues[nowValues.length - 1];
    vi.spyOn(Date, 'now').mockImplementation(() => {
      const next = nowValues.shift();
      if (next == null) return lastNow;
      lastNow = next;
      return next;
    });

    const { executeTool } = await import('../container/src/tools.js');
    const result = await executeTool(
      'grep',
      JSON.stringify({
        pattern: 'needle',
      }),
    );

    expect(result).toContain('grep search timed out after 30s');
    expect(result).not.toContain('match.txt:1:> needle');
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

  test('skips pinned files such as .env without reading them when walking the workspace', async () => {
    createWorkspaceWithEnvFiles();

    const { executeTool } = await import('../container/src/tools.js');
    const openSpy = vi.spyOn(fs, 'openSync');
    const result = await executeTool(
      'grep',
      JSON.stringify({
        pattern: 'API_KEY',
      }),
    );

    expect(result).toContain('src/app.ts:1:> const key = process.env.API_KEY;');
    expect(result).not.toContain('test-key');
    expect(result).toContain(
      'Skipped 3 files matching pinned paths (.env*, /etc/**, ~/.ssh/**)',
    );
    const openedEnvFiles = openSpy.mock.calls
      .map(([filePath]) => path.basename(String(filePath)))
      .filter((name) => name.startsWith('.env'));
    expect(openedEnvFiles).toEqual([]);
  });

  test('searches a pinned file named explicitly as the path', async () => {
    createWorkspaceWithEnvFiles();

    const { executeTool } = await import('../container/src/tools.js');
    const result = await executeTool(
      'grep',
      JSON.stringify({
        pattern: 'API_KEY',
        path: '.env.local',
      }),
    );

    expect(result).toBe('.env.local:1:> API_KEY=test-key-local');
  });

  test('searches pinned files selected by an include pattern', async () => {
    createWorkspaceWithEnvFiles();

    const { executeTool } = await import('../container/src/tools.js');
    const result = await executeTool(
      'grep',
      JSON.stringify({
        pattern: 'API_KEY',
        include: '.env*',
      }),
    );

    expect(result).toContain('.env:1:> API_KEY=test-key-root');
    expect(result).toContain('.env.local:1:> API_KEY=test-key-local');
    expect(result).toContain(
      'config/.env.production:1:> API_KEY=test-key-prod',
    );
    expect(result).not.toContain('src/app.ts');
    expect(result).not.toContain('Skipped');
  });

  test('skips ~/.ssh when a host-mode search walks the home directory', async () => {
    const homeDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-grep-home-'),
    );
    workspaceRoot = homeDir;
    fs.mkdirSync(path.join(homeDir, '.ssh'));
    fs.mkdirSync(path.join(homeDir, 'workspace'));
    fs.writeFileSync(
      path.join(homeDir, '.ssh', 'id_ed25519'),
      'PRIVATE KEY test-key',
    );
    fs.writeFileSync(
      path.join(homeDir, 'notes.txt'),
      'PRIVATE KEY rotation notes',
    );
    vi.stubEnv('HOME', homeDir);
    vi.stubEnv(
      'HYBRIDCLAW_AGENT_WORKSPACE_ROOT',
      path.join(homeDir, 'workspace'),
    );
    vi.stubEnv('HYBRIDCLAW_AGENT_ALLOWED_ROOTS', JSON.stringify([homeDir]));

    const { executeTool } = await import('../container/src/tools.js');
    const walked = await executeTool(
      'grep',
      JSON.stringify({
        pattern: 'PRIVATE KEY',
        path: '~',
      }),
    );
    const explicit = await executeTool(
      'grep',
      JSON.stringify({
        pattern: 'PRIVATE KEY',
        path: '~/.ssh',
      }),
    );

    expect(walked).toContain('notes.txt:1:> PRIVATE KEY rotation notes');
    expect(walked).not.toContain('test-key');
    expect(walked).toContain('Skipped 1 file matching pinned paths');
    expect(explicit).toContain('id_ed25519:1:> PRIVATE KEY test-key');
    expect(explicit).not.toContain('Skipped');
  });

  test('skips pinned files listed by the task sandbox without reading them', async () => {
    workspaceRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-grep-workspace-'),
    );
    vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', workspaceRoot);
    vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_DISPLAY_ROOT', '/app');
    vi.stubEnv('HYBRIDCLAW_BASH_DOCKER_CONTAINER', 'task-sandbox');
    vi.stubEnv('HYBRIDCLAW_BASH_DOCKER_CWD', '/app');
    const sandboxFiles: Record<string, string> = {
      '/app/.env': 'API_KEY=test-key',
      '/app/src/app.ts': 'const key = process.env.API_KEY;',
    };
    const spawnSync = vi.fn((_command: string, args: string[]) => {
      const shellCommand = String(args.at(-1) || '');
      if (shellCommand.startsWith('if [ -f')) {
        return {
          status: 0,
          stdout: Object.keys(sandboxFiles)
            .map((filePath) => `${filePath}\0`)
            .join(''),
          stderr: '',
        };
      }
      const filePath = Object.keys(sandboxFiles).find((candidate) =>
        shellCommand.endsWith(`'${candidate}'`),
      );
      return {
        status: 0,
        stdout: filePath ? sandboxFiles[filePath] : '',
        stderr: '',
      };
    });
    vi.doMock('node:child_process', async () => {
      const actual =
        await vi.importActual<typeof import('node:child_process')>(
          'node:child_process',
        );
      return {
        ...actual,
        spawnSync,
      };
    });

    const { executeTool } = await import('../container/src/tools.js');
    const result = await executeTool(
      'grep',
      JSON.stringify({
        pattern: 'API_KEY',
      }),
    );

    expect(result).toContain('src/app.ts:1:> const key = process.env.API_KEY;');
    expect(result).not.toContain('test-key');
    expect(result).toContain('Skipped 1 file matching pinned paths');
    const envFileCommands = spawnSync.mock.calls
      .map(([, args]) => String(args.at(-1)))
      .filter((command) => command.includes('/app/.env'));
    expect(envFileCommands).toEqual([]);
  });
});
