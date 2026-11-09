import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.js';

const tempDir = useTempDir();
useCleanMocks({ unstubAllEnvs: true, resetModules: true });

test.each(['/app', '/project', '/workspace'])(
  'file tools preserve a directory named after the display root %s',
  async (displayRoot) => {
    const root = tempDir('relative-paths-');
    const nested = path.posix.basename(displayRoot);
    fs.mkdirSync(path.join(root, nested));
    fs.writeFileSync(path.join(root, 'config.txt'), 'root value');
    fs.writeFileSync(path.join(root, nested, 'config.txt'), 'nested value');
    vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', root);
    vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_DISPLAY_ROOT', displayRoot);
    const hostOnlyRoot = tempDir('host-only-paths-');
    vi.stubEnv(
      'HYBRIDCLAW_AGENT_ALLOWED_ROOTS',
      JSON.stringify([hostOnlyRoot]),
    );
    const { executeToolWithMetadata: execute } = await import(
      '../container/src/tools.js'
    );
    const call = (name: string, args: Record<string, unknown>) =>
      execute(name, JSON.stringify(args));

    expect(await call('read', { path: `${nested}/config.txt` })).toMatchObject({
      isError: false,
      output: expect.stringContaining('nested value'),
    });
    expect(
      await call('edit', {
        path: `${nested}/config.txt`,
        old: 'nested value',
        new: 'updated value',
      }),
    ).toMatchObject({ isError: false });
    expect(
      await call('read', { path: `${displayRoot}/${nested}/config.txt` }),
    ).toMatchObject({
      isError: false,
      output: expect.stringContaining('updated value'),
    });
    expect(
      await call('write', { path: `${nested}/new.txt`, contents: 'new value' }),
    ).toMatchObject({ isError: false });
    expect(fs.readFileSync(path.join(root, nested, 'new.txt'), 'utf8')).toBe(
      'new value',
    );
    expect(fs.existsSync(path.join(root, 'new.txt'))).toBe(false);
    expect(fs.readFileSync(path.join(root, 'config.txt'), 'utf8')).toBe(
      'root value',
    );

    const {
      resolveWorkspacePath,
      resolveWorkspaceGlobPattern,
      resolveTaskSandboxPath,
    } = await import('../container/src/runtime-paths.js');
    expect(resolveWorkspacePath(path.join(hostOnlyRoot, 'note.txt'))).toBe(
      path.join(hostOnlyRoot, 'note.txt'),
    );
    expect(
      resolveTaskSandboxPath(path.join(hostOnlyRoot, 'note.txt')),
    ).toBeNull();
    expect(resolveTaskSandboxPath(`${nested}/config.txt`)).toBe(
      `${displayRoot}/${nested}/config.txt`,
    );
    expect(resolveWorkspaceGlobPattern(`${nested}/*.txt`)).toBe(
      path.join(root, nested, '*.txt'),
    );
    expect(resolveWorkspaceGlobPattern(`${nested}/config.txt`)).toBe(
      path.join(root, nested, 'config.txt'),
    );
    for (const escaped of ['../outside.txt', `${nested}/../../outside.txt`]) {
      expect(resolveWorkspacePath(escaped)).toBeNull();
      expect(resolveTaskSandboxPath(escaped)).toBeNull();
      expect(
        await call('write', { path: escaped, contents: 'blocked' }),
      ).toMatchObject({
        isError: true,
      });
    }
    expect(fs.readFileSync(path.join(root, nested, 'config.txt'), 'utf8')).toBe(
      'updated value',
    );
  },
);
