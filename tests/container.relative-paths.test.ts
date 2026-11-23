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
      resolveFileToolGlob,
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
    expect(resolveFileToolGlob(`${nested}/*.txt`)).toEqual({
      root: path.join(root, nested),
      pattern: '*.txt',
    });
    expect(resolveFileToolGlob(`${nested}/config.txt`)?.root).toBe(
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

test('search results round-trip through read with a nested workspace and a shadowed display root', async () => {
  const display = tempDir('search-round-trip-');
  const root = path.join(display, '.data', 'agents', '[test]', 'workspace');
  const relative = 'audit/report.txt';
  for (const [base, text] of [
    [root, 'workspace match'],
    [display, 'external match'],
  ]) {
    fs.mkdirSync(path.join(base, 'audit'), { recursive: true });
    fs.writeFileSync(path.join(base, relative), text);
  }
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', root);
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_DISPLAY_ROOT', display);
  vi.stubEnv('HYBRIDCLAW_AGENT_ALLOWED_ROOTS', JSON.stringify([display]));
  const { executeTool } = await import('../container/src/tools.js');
  for (const [base, name, content] of [
    [root, relative, 'workspace match'],
    [display, path.join(display, relative), 'external match'],
  ]) {
    const dir = path.join(base, 'audit');
    const found = await executeTool(
      'glob',
      JSON.stringify({ pattern: path.join(dir, '*.txt') }),
    );
    expect(found.trim()).toBe(name);
    expect(
      await executeTool('read', JSON.stringify({ path: found.trim() })),
    ).toContain(content);
    expect(
      await executeTool(
        'grep',
        JSON.stringify({ path: dir, pattern: content }),
      ),
    ).toContain(name);
  }
});

test('task-container path identities use the task filesystem even when the host claims the display root', async () => {
  vi.stubEnv('HYBRIDCLAW_BASH_DOCKER_CONTAINER', 'fixture');
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_DISPLAY_ROOT', '/app');
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', '/app/.data/workspace');
  vi.stubEnv('HYBRIDCLAW_AGENT_ALLOWED_ROOTS', '["/app"]');
  const { describeFileToolPath, resolveFileToolPath } = await import(
    '../container/src/runtime-paths.js'
  );
  expect(resolveFileToolPath('/other/report.md')).toBeNull();
  expect(
    describeFileToolPath(
      'report.md',
      'Replace /app/.data/workspace/report.md or /app/report.md',
    ),
  ).toEqual({
    path: 'report.md',
    path_aliases: ['/app/report.md'],
  });
});

test('a task fence follows the task workspace across spellings and worker replacement', async () => {
  const display = tempDir('display-root-');
  const root = path.join(display, '.data', 'workspace');
  fs.mkdirSync(root, { recursive: true });
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', root);
  vi.stubEnv('HYBRIDCLAW_AGENT_STATE_ROOT', root);
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_DISPLAY_ROOT', display);
  vi.stubEnv('HYBRIDCLAW_AGENT_ALLOWED_ROOTS', JSON.stringify([display]));
  vi.stubEnv('HYBRIDCLAW_BASH_DOCKER_CONTAINER', 'task');
  const state = await import('../container/src/file-write-conflicts.js');
  const relative = 'audit/report.md';
  const absolute = path.join(display, relative);
  await state.recordFileWriteConflict('s', absolute);
  vi.resetModules();
  const restarted = await import('../container/src/file-write-conflicts.js');
  expect(restarted.getFileWriteConflict('s', relative)).toBe(
    path.join(fs.realpathSync(root), relative),
  );
  expect(restarted.getFileWriteConflict('s', 'other/report.md')).toBeNull();
  await restarted.resolveFileWriteConflict('s', relative);
  expect(restarted.getFileWriteConflict('s', absolute)).toBeNull();
});

test('a task worker honors an existing host fence without clearing another file’s fence', async () => {
  const display = tempDir();
  const root = path.join(display, 'agent');
  fs.mkdirSync(root);
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', root);
  vi.stubEnv('HYBRIDCLAW_AGENT_STATE_ROOT', root);
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_DISPLAY_ROOT', display);
  vi.stubEnv('HYBRIDCLAW_AGENT_ALLOWED_ROOTS', JSON.stringify([display]));
  const host = await import('../container/src/file-write-conflicts.js');
  const external = path.join(display, 'report.md');
  await host.recordFileWriteConflict('shared', external);

  vi.stubEnv('HYBRIDCLAW_BASH_DOCKER_CONTAINER', 'fixture');
  vi.resetModules();
  const task = await import('../container/src/file-write-conflicts.js');
  expect(task.getFileWriteConflict('shared', 'report.md')).toBe(external);
  await task.resolveFileWriteConflict('shared', 'report.md');
  expect(task.getFileWriteConflict('shared', 'report.md')).toBe(external);
});

test('host tools preserve a literal tilde directory when reporting files', async () => {
  const root = tempDir();
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', root);
  const { resolveFileToolGlob, resolveFileToolPath, toFileToolPath } =
    await import('../container/src/runtime-paths.js');
  const target = path.join(root, '~', 'report.md');
  expect(resolveFileToolPath(toFileToolPath(target))).toBe(target);
  expect(resolveFileToolGlob('./~/*.md')?.root).toBe(path.dirname(target));
});

test('shell output abbreviates one real workspace prefix and preserves other absolute paths', async () => {
  const display = '/workspace';
  const root = '/workspace/.data/agents/test/workspace';
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', root);
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_DISPLAY_ROOT', display);
  const { replaceWorkspaceRootInOutput } = await import(
    '../container/src/runtime-paths.js'
  );
  expect(
    replaceWorkspaceRootInOutput(
      [
        `${root}/src/workspace/file`,
        root,
        '/workspace/external.txt',
        `/elsewhere${root}/file`,
      ].join('\n'),
    ),
  ).toBe(
    [
      'src/workspace/file',
      '.',
      '/workspace/external.txt',
      `/elsewhere${root}/file`,
    ].join('\n'),
  );
});

test('file batches respect the canonical target and the directory containing a symlink', async () => {
  const root = tempDir();
  fs.mkdirSync(path.join(root, 'links'));
  fs.writeFileSync(path.join(root, 'report.txt'), 'one');
  fs.symlinkSync(
    path.join(root, 'report.txt'),
    path.join(root, 'links', 'alias'),
  );
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', root);
  const { leadingParallelRun } = await import(
    '../container/src/tool-parallelism.js'
  );
  const tool = (name: string, file: string) => ({
    id: name,
    type: 'function' as const,
    function: { name, arguments: JSON.stringify({ path: file }) },
  });
  const read = tool('read', 'links/alias');
  for (const mutation of [
    tool('write', 'report.txt'),
    tool('delete', 'links'),
  ]) {
    expect(leadingParallelRun([read, mutation])).toEqual([read]);
  }
});
