import { afterEach, expect, test, vi } from 'vitest';

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function importFreshRuntimeFactory() {
  vi.resetModules();
  const registerChannel = vi.fn();
  vi.doMock('../src/channels/channel-registry.js', () => ({
    registerChannel,
  }));

  const channelModule = await import('../src/channels/channel.js');
  const runtimeFactoryModule = await import(
    '../src/channels/channel-runtime-factory.js'
  );

  return {
    ...channelModule,
    ...runtimeFactoryModule,
    registerChannel,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock('../src/channels/channel-registry.js');
  vi.resetModules();
});

test('shutdown invalidates init before runtime side effects begin', async () => {
  const { EMAIL_CAPABILITIES, createChannelRuntime, registerChannel } =
    await importFreshRuntimeFactory();
  const resolveConfigGate = createDeferred<void>();
  const start = vi.fn(async () => {});

  const runtime = createChannelRuntime<void, void>({
    kind: 'email',
    capabilities: EMAIL_CAPABILITIES,
    resolveConfig: async () => {
      await resolveConfigGate.promise;
    },
    start,
  });

  const initPromise = runtime.init(undefined);
  await runtime.shutdown();
  resolveConfigGate.resolve();
  await initPromise;

  expect(registerChannel).not.toHaveBeenCalled();
  expect(start).not.toHaveBeenCalled();
});

test('shutdown prevents a late init completion from sticking', async () => {
  const { EMAIL_CAPABILITIES, createChannelRuntime, registerChannel } =
    await importFreshRuntimeFactory();
  const startEntered = createDeferred<void>();
  const releaseFirstStart = createDeferred<void>();
  const cleanup = vi.fn(async () => {});
  const start = vi.fn(async () => {});
  start.mockImplementationOnce(async () => {
    startEntered.resolve();
    await releaseFirstStart.promise;
  });

  const runtime = createChannelRuntime<void, void>({
    kind: 'email',
    capabilities: EMAIL_CAPABILITIES,
    start,
    cleanup,
  });

  const firstInit = runtime.init(undefined);
  await startEntered.promise;
  await runtime.shutdown();
  releaseFirstStart.resolve();
  await firstInit;
  await runtime.init(undefined);

  expect(start).toHaveBeenCalledTimes(2);
  expect(cleanup).toHaveBeenCalledTimes(2);
  expect(registerChannel).toHaveBeenCalledTimes(2);
});
