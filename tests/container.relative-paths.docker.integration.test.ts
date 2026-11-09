import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.js';

const tempDir = useTempDir();
let container = '';
useCleanMocks({ unstubAllEnvs: true, resetModules: true });
afterEach(() => {
  if (container) spawnSync('docker', ['rm', '-f', container]);
  container = '';
});

test.skipIf(process.env.HYBRIDCLAW_TEST_DOCKER !== '1')(
  'sandbox file tools keep nested paths after the shell changes directory',
  async () => {
    const root = tempDir('sandbox-relative-paths-');
    fs.mkdirSync(path.join(root, 'app'));
    fs.writeFileSync(path.join(root, 'config.txt'), 'root value');
    fs.writeFileSync(path.join(root, 'app/config.txt'), 'nested value');
    container = `hc-relative-paths-${randomUUID()}`;
    const started = spawnSync(
      'docker',
      [
        'run',
        '-d',
        '--cpus=1',
        '--memory=256m',
        '--memory-swap=256m',
        '--name',
        container,
        '-v',
        `${root}:/app`,
        '-w',
        '/app',
        '--entrypoint',
        'sleep',
        process.env.HYBRIDCLAW_TEST_DOCKER_IMAGE || 'node:22-slim',
        'infinity',
      ],
      { encoding: 'utf8', timeout: 30_000 },
    );
    expect(started.status, started.stderr).toBe(0);
    vi.stubEnv('HYBRIDCLAW_BASH_DOCKER_CONTAINER', container);
    vi.stubEnv('HYBRIDCLAW_BASH_DOCKER_CWD', '/app');
    vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', root);
    vi.stubEnv('HYBRIDCLAW_AGENT_STATE_ROOT', root);
    vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_DISPLAY_ROOT', '/app');
    const { executeToolWithMetadata: execute, setSessionContext } =
      await import('../container/src/tools.js');
    setSessionContext('relative-paths');
    const call = (name: string, args: Record<string, unknown>) =>
      execute(name, JSON.stringify(args));
    expect(
      await call('bash', { command: 'cd app && cat config.txt' }),
    ).toMatchObject({
      isError: false,
      output: expect.stringContaining('nested value'),
    });
    expect(await call('read', { path: 'app/config.txt' })).toMatchObject({
      isError: false,
      output: expect.stringContaining('nested value'),
    });
    expect(
      await call('edit', {
        path: 'app/config.txt',
        old: 'nested value',
        new: 'updated value',
      }),
    ).toMatchObject({ isError: false });
    expect(await call('read', { path: '/app/app/config.txt' })).toMatchObject({
      isError: false,
      output: expect.stringContaining('updated value'),
    });
    expect(await call('glob', { pattern: 'app/config.txt' })).toMatchObject({
      isError: false,
      output: expect.stringContaining('app/config.txt'),
    });
    expect(
      await call('grep', { path: 'app', pattern: 'updated value' }),
    ).toMatchObject({
      isError: false,
      output: expect.stringContaining('updated value'),
    });
    expect(
      await call('write', { path: 'app/new.txt', contents: 'new value' }),
    ).toMatchObject({ isError: false });
    expect(
      await call('write', { path: 'app/config.txt', contents: 'accidental' }),
    ).toMatchObject({ isError: true });
    expect(
      await call('write', { path: '../outside.txt', contents: 'blocked' }),
    ).toMatchObject({ isError: true });
    expect(fs.readFileSync(path.join(root, 'app/config.txt'), 'utf8')).toBe(
      'updated value',
    );
    expect(fs.readFileSync(path.join(root, 'config.txt'), 'utf8')).toBe(
      'root value',
    );
    expect(fs.readFileSync(path.join(root, 'app/new.txt'), 'utf8')).toBe(
      'new value',
    );
    expect(fs.existsSync(path.join(root, 'new.txt'))).toBe(false);
  },
);
