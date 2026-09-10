/**
 * Desktop lifecycle tests assert ownership across sleep, wake and external owners.
 * They never launch a model, installer or gateway process.
 */
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  error: vi.fn(),
  dialog: vi.fn(),
  windows: [] as Array<{ emit: (event: string) => boolean }>,
}));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    BrowserWindow: class extends EventEmitter {
      constructor() {
        super();
        mocks.windows.push(this);
      }
      loadURL = vi.fn(async () => {});
      isDestroyed = () => false;
      close() {
        this.emit('close');
      }
    },
    dialog: { showErrorBox: mocks.error, showMessageBox: mocks.dialog },
  };
});

import { DesktopMlxRuntime } from './mlx-runtime.js';

class Child extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill = vi.fn(() => {
    queueMicrotask(() => this.emit('exit', 0));
    return true;
  });
}
function fixture() {
  const children: Child[] = [];
  mocks.spawn.mockImplementation(() => {
    const child = new Child();
    children.push(child);
    return child;
  });
  const runtime = new DesktopMlxRuntime({
    baseUrl: 'http://127.0.0.1:9090',
    packaged: false,
    processEnv: {},
    processExecPath: '/example/node',
    runtimeRoot: '/example/runtime',
  });
  return { runtime, children };
}
afterEach(() => {
  vi.clearAllMocks();
  mocks.windows.length = 0;
});
test('starts one owned inference process and never starts a gateway', async () => {
  const { runtime, children } = fixture();
  await runtime.start();
  await runtime.start();
  expect(mocks.spawn).toHaveBeenCalledTimes(1);
  expect(mocks.spawn.mock.calls[0][1]).toEqual([
    '/example/runtime/dist/cli.js',
    'local',
    'serve',
    '--if-configured',
  ]);
  await runtime.stop();
  expect(children[0].kill).toHaveBeenCalledWith('SIGTERM');
});
test('sleep unloads and wake resumes the previously owned model', async () => {
  const { runtime, children } = fixture();
  await runtime.start();
  runtime.suspend();
  runtime.resume();
  await vi.waitFor(() => expect(children).toHaveLength(2));
  expect(children[0].kill).toHaveBeenCalledOnce();
  await runtime.stop();
});
test('does not take ownership of an external service or resume an explicitly stopped model', async () => {
  const { runtime, children } = fixture();
  await runtime.start();
  children[0].emit('exit', 0);
  runtime.suspend();
  runtime.resume();
  expect(mocks.spawn).toHaveBeenCalledTimes(1);
  expect(children[0].kill).not.toHaveBeenCalled();
  await runtime.start();
  await runtime.stop();
  runtime.resume();
  expect(mocks.spawn).toHaveBeenCalledTimes(2);
});

test('closing setup stops its installer without starting a model or showing a failure dialog', async () => {
  const { runtime, children } = fixture();
  mocks.dialog.mockResolvedValue({ response: 0 });
  const setup = runtime.setup();
  children[0].stdout.write(
    JSON.stringify({
      supported: true,
      recommended: 'test-model',
      hardware: { chip: 'Example Apple silicon', memoryBytes: 16 * 1024 ** 3 },
      reservedBytes: 4 * 1024 ** 3,
      candidates: [
        {
          id: 'test-model',
          label: 'Test model',
          weightBytes: 2 * 1024 ** 3,
          fits: true,
          contextWindow: 4096,
        },
      ],
      unavailable: [],
    }),
  );
  children[0].emit('exit', 0);
  await vi.waitFor(() => expect(children).toHaveLength(2));
  mocks.windows[0].emit('close');
  await setup;
  await runtime.stop();
  expect(children[1].kill).toHaveBeenCalledWith('SIGTERM');
  expect(mocks.spawn).toHaveBeenCalledTimes(2);
  expect(mocks.error).not.toHaveBeenCalled();
});

test('the full shortlist explains unavailable models without launching an installer', async () => {
  const { runtime, children } = fixture();
  mocks.dialog
    .mockResolvedValueOnce({ response: 1 })
    .mockResolvedValueOnce({ response: 0 })
    .mockResolvedValueOnce({ response: 2 });
  const setup = runtime.setup();
  children[0].stdout.write(
    JSON.stringify({
      supported: true,
      recommended: 'test-model',
      reservedBytes: 4 * 1024 ** 3,
      hardware: { chip: 'Example Apple silicon', memoryBytes: 16 * 1024 ** 3 },
      candidates: [
        {
          id: 'test-model',
          label: 'Test model',
          weightBytes: 2 * 1024 ** 3,
          fits: true,
          contextWindow: 4096,
        },
      ],
      unavailable: [
        {
          label: 'Nex Pro',
          listedMemoryGb: '196–256',
          reason: 'Weights are not published.',
        },
      ],
    }),
  );
  children[0].emit('exit', 0);
  await setup;
  expect(mocks.dialog.mock.calls[1][0].detail).toContain('Nex Pro');
  expect(mocks.dialog.mock.calls[1][0].detail).toContain(
    'Weights are not published.',
  );
  expect(mocks.spawn).toHaveBeenCalledTimes(1);
});
