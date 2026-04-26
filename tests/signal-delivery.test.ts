import { beforeEach, expect, test, vi } from 'vitest';

const callSignalRpcMock = vi.fn();

vi.mock('../src/channels/signal/api.js', async () => {
  const actual = await vi.importActual('../src/channels/signal/api.js');
  return {
    ...actual,
    callSignalRpc: callSignalRpcMock,
  };
});

vi.mock('../src/config/config.js', () => ({
  getConfigSnapshot: () => ({
    signal: {
      textChunkLimit: 4_000,
    },
  }),
}));

beforeEach(() => {
  callSignalRpcMock.mockReset();
  callSignalRpcMock.mockResolvedValue(undefined);
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
