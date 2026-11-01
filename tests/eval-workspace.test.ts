import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.js';

const tempDir = useTempDir();
useCleanMocks({ unstubAllEnvs: true, resetModules: true });
const stateRoot = vi.hoisted(() => ({ value: '', mode: 'host' }));
const bootstrap = vi.hoisted(() => vi.fn());
vi.mock('../src/infra/host-workspace.js', () => ({
  hostWorkspaceStateRoot: () => stateRoot.value,
}));
vi.mock('../src/infra/ipc.js', () => ({
  ensureAgentDirs: () => fs.mkdirSync(stateRoot.value, { recursive: true }),
}));
vi.mock('../src/workspace.js', () => ({ ensureBootstrapFiles: bootstrap }));
vi.mock('../src/config/config.js', () => ({
  get CONTAINER_SANDBOX_MODE() {
    return stateRoot.mode;
  },
}));

async function fixture() {
  stateRoot.value = path.join(tempDir(), 'agent');
  stateRoot.mode = 'host';
  bootstrap.mockReset();
  const task = tempDir();
  vi.stubEnv('HYBRIDCLAW_EVAL_WORKSPACE_ROOT', task);
  const { evalWorkspaceOverrides } = await import(
    '../src/gateway/eval-workspace.js'
  );
  return {
    task,
    resolve: (isEval = true) => evalWorkspaceOverrides(isEval, 'main'),
  };
}

test('only explicit evals use the operator root and bootstrap stays agent-local', async () => {
  const { task, resolve } = await fixture();
  expect(resolve(false)).toEqual({});
  expect(bootstrap).not.toHaveBeenCalled();
  expect(resolve()).toEqual({
    workspacePathOverride: fs.realpathSync(task),
    workspaceDisplayRootOverride: fs.realpathSync(task),
  });
  expect(bootstrap).toHaveBeenCalledWith('main');
  expect(fs.readdirSync(task)).toEqual([]);
});

test('without the operator setting, an eval uses its normal workspace', async () => {
  const { resolve } = await fixture();
  vi.stubEnv('HYBRIDCLAW_EVAL_WORKSPACE_ROOT', '');
  expect(resolve()).toEqual({});
  expect(bootstrap).not.toHaveBeenCalled();
});

test.each(['relative', 'missing', 'file', 'container'])(
  'rejects an invalid eval root: %s',
  async (kind) => {
    const { task, resolve } = await fixture();
    if (kind === 'relative')
      vi.stubEnv('HYBRIDCLAW_EVAL_WORKSPACE_ROOT', 'relative/path');
    if (kind === 'missing')
      vi.stubEnv('HYBRIDCLAW_EVAL_WORKSPACE_ROOT', path.join(task, 'missing'));
    if (kind === 'file') {
      const file = path.join(task, 'file');
      fs.writeFileSync(file, 'input');
      vi.stubEnv('HYBRIDCLAW_EVAL_WORKSPACE_ROOT', file);
    }
    if (kind === 'container') stateRoot.mode = 'container';
    expect(resolve).toThrow();
    expect(bootstrap).not.toHaveBeenCalled();
  },
);

test.each(['same', 'child', 'parent', 'symlink'])(
  'rejects overlapping task and state paths before bootstrap: %s',
  async (kind) => {
    const { task, resolve } = await fixture();
    if (kind === 'same') stateRoot.value = task;
    if (kind === 'child') {
      stateRoot.value = task;
      const child = path.join(task, 'child');
      fs.mkdirSync(child);
      vi.stubEnv('HYBRIDCLAW_EVAL_WORKSPACE_ROOT', child);
    }
    if (kind === 'parent') stateRoot.value = path.join(task, 'agent');
    if (kind === 'symlink') {
      fs.mkdirSync(path.dirname(stateRoot.value), { recursive: true });
      fs.symlinkSync(task, stateRoot.value);
    }
    expect(resolve).toThrow('separate directories');
    expect(bootstrap).not.toHaveBeenCalled();
  },
);
