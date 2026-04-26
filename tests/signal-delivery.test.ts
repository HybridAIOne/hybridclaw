import { beforeEach, expect, test, vi } from 'vitest';

const callSignalRpcMock = vi.fn();
const sleepMock = vi.fn(async () => {});
let signalConfig = {
  textChunkLimit: 4_000,
  outboundDelayMs: 350,
};

vi.mock('../src/channels/signal/api.js', async () => {
  const actual = await vi.importActual('../src/channels/signal/api.js');
  return {
    ...actual,
    callSignalRpc: callSignalRpcMock,
  };
});

vi.mock('../src/config/config.js', () => ({
  getConfigSnapshot: () => ({
    signal: signalConfig,
  }),
}));

vi.mock('../src/utils/sleep.js', () => ({
  sleep: sleepMock,
}));

beforeEach(() => {
  callSignalRpcMock.mockReset();
  callSignalRpcMock.mockResolvedValue(null);
  sleepMock.mockClear();
  signalConfig = {
    textChunkLimit: 4_000,
    outboundDelayMs: 350,
  };
});

test('starts Signal typing without a stop flag', async () => {
  const { sendSignalTyping } = await import(
    '../src/channels/signal/delivery.js'
  );

  await sendSignalTyping({
    daemonUrl: 'http://127.0.0.1:8080',
    account: '+15555550123',
    target: 'signal:+15555550123',
  });

  expect(callSignalRpcMock).toHaveBeenCalledWith(
    'http://127.0.0.1:8080',
    'sendTyping',
    {
      account: '+15555550123',
      recipient: ['+15555550123'],
    },
  );
});

test('clears Signal typing with stop flag', async () => {
  const { sendSignalTyping } = await import(
    '../src/channels/signal/delivery.js'
  );

  await sendSignalTyping({
    daemonUrl: 'http://127.0.0.1:8080',
    account: '+15555550123',
    target: 'signal:+15555550123',
    stop: true,
  });

  expect(callSignalRpcMock).toHaveBeenCalledWith(
    'http://127.0.0.1:8080',
    'sendTyping',
    {
      account: '+15555550123',
      stop: true,
      recipient: ['+15555550123'],
    },
  );
});

test('uses configured Signal outbound delay between chunks', async () => {
  signalConfig = {
    textChunkLimit: 200,
    outboundDelayMs: 25,
  };
  callSignalRpcMock.mockResolvedValue({ timestamp: 123 });
  const { sendChunkedSignalText } = await import(
    '../src/channels/signal/delivery.js'
  );

  await sendChunkedSignalText({
    daemonUrl: 'http://127.0.0.1:8080',
    account: '+15555550123',
    target: 'signal:+15555550123',
    text: `${'a'.repeat(200)} ${'b'.repeat(200)}`,
  });

  expect(callSignalRpcMock).toHaveBeenCalledTimes(2);
  expect(sleepMock).toHaveBeenCalledWith(25);
});
