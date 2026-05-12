import { afterEach, expect, test, vi } from 'vitest';

function createSignalConfig(reconnectIntervalMs: number) {
  return {
    enabled: true,
    daemonUrl: 'http://signal.example.com',
    account: '+15555550123',
    dmPolicy: 'allowlist' as const,
    groupPolicy: 'disabled' as const,
    allowFrom: ['+15555550123'],
    groupAllowFrom: [],
    textChunkLimit: 4_000,
    reconnectIntervalMs,
    outboundDelayMs: 350,
  };
}

async function importSignalRuntime(options: {
  reconnectIntervalMs: number;
  agents?: {
    list?: Array<{ id: string; displayName?: string; name?: string }>;
  };
  sessionAgentId?: string;
}) {
  vi.resetModules();

  vi.doMock('../src/config/config.js', () => ({
    getConfigSnapshot: () => ({
      signal: createSignalConfig(options.reconnectIntervalMs),
      agents: options.agents || { list: [] },
    }),
  }));

  const doneResolvers: Array<() => void> = [];
  const aborts: Array<ReturnType<typeof vi.fn>> = [];
  const eventHandlers: Array<(event: unknown) => void> = [];
  const streamSignalEvents = vi.fn(
    (params: { onEvent: (event: unknown) => void }) => {
      let resolveDone!: () => void;
      const done = new Promise<void>((resolve) => {
        resolveDone = resolve;
      });
      doneResolvers.push(resolveDone);
      eventHandlers.push(params.onEvent);
      const abort = vi.fn(resolveDone);
      aborts.push(abort);
      return { abort, done };
    },
  );
  const sendChunkedSignalText = vi.fn(async () => []);
  const sendSignalTyping = vi.fn(async () => true);

  vi.doMock('../src/channels/signal/api.js', async () => {
    const actual = await vi.importActual('../src/channels/signal/api.js');
    return {
      ...actual,
      streamSignalEvents,
    };
  });
  vi.doMock('../src/channels/signal/delivery.js', () => ({
    sendChunkedSignalText,
    sendSignalTyping,
  }));
  vi.doMock('../src/memory/memory-service.js', () => ({
    memoryService: {
      getSessionById: vi.fn(() =>
        options.sessionAgentId
          ? { agent_id: options.sessionAgentId }
          : undefined,
      ),
    },
  }));

  const runtime = await import('../src/channels/signal/runtime.js');
  return {
    ...runtime,
    aborts,
    doneResolvers,
    eventHandlers,
    sendChunkedSignalText,
    sendSignalTyping,
    streamSignalEvents,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetModules();
});

test('uses configured reconnect interval as Signal stream retry base delay', async () => {
  vi.useFakeTimers();

  const runtime = await importSignalRuntime({ reconnectIntervalMs: 4_000 });

  await runtime.initSignal(async () => {});
  expect(runtime.streamSignalEvents).toHaveBeenCalledTimes(1);

  runtime.doneResolvers[0]();
  await vi.advanceTimersByTimeAsync(3_999);
  expect(runtime.streamSignalEvents).toHaveBeenCalledTimes(1);

  await vi.advanceTimersByTimeAsync(1);
  expect(runtime.streamSignalEvents).toHaveBeenCalledTimes(2);

  await runtime.shutdownSignal();
  expect(runtime.aborts.at(-1)).toHaveBeenCalledTimes(1);
});

test('prefixes Signal Note-to-Self replies with HybridClaw', async () => {
  const runtime = await importSignalRuntime({ reconnectIntervalMs: 4_000 });

  await runtime.initSignal(async (...args: unknown[]) => {
    const reply = args[6] as (content: string) => Promise<void>;
    await reply('hello from the bot');
  });

  runtime.eventHandlers[0]?.({
    account: '+15555550123',
    envelope: {
      source: '+15555550123',
      sourceNumber: '+15555550123',
      sourceName: 'Benedikt Koehler',
      sourceDevice: 1,
      timestamp: 1_777_193_823_147,
      syncMessage: {
        sentMessage: {
          destinationNumber: '+15555550123',
          timestamp: 1_777_193_823_147,
          message: 'Hi!',
        },
      },
    },
  });

  await vi.waitFor(() => {
    expect(runtime.sendChunkedSignalText).toHaveBeenCalledWith(
      expect.objectContaining({
        target: 'signal:+15555550123',
        text: '[HybridClaw] hello from the bot',
      }),
    );
  });

  await runtime.shutdownSignal();
});

test('prefixes Signal Note-to-Self replies with agent name', async () => {
  const runtime = await importSignalRuntime({
    reconnectIntervalMs: 4_000,
    agents: { list: [{ id: 'charly', displayName: 'Charly' }] },
    sessionAgentId: 'charly',
  });

  await runtime.initSignal(async (...args: unknown[]) => {
    const reply = args[6] as (content: string) => Promise<void>;
    await reply('hello from the bot');
  });

  runtime.eventHandlers[0]?.({
    account: '+15555550123',
    envelope: {
      source: '+15555550123',
      sourceNumber: '+15555550123',
      sourceName: 'Benedikt Koehler',
      sourceDevice: 1,
      timestamp: 1_777_193_823_147,
      syncMessage: {
        sentMessage: {
          destinationNumber: '+15555550123',
          timestamp: 1_777_193_823_147,
          message: 'Hi!',
        },
      },
    },
  });

  await vi.waitFor(() => {
    expect(runtime.sendChunkedSignalText).toHaveBeenCalledWith(
      expect.objectContaining({
        target: 'signal:+15555550123',
        text: '[Charly] hello from the bot',
      }),
    );
  });

  await runtime.shutdownSignal();
});
