import { afterEach, expect, test, vi } from 'vitest';

const { enqueueSteeringNoteMock, stopSessionExecutionMock } = vi.hoisted(
  () => ({
    enqueueSteeringNoteMock: vi.fn(),
    stopSessionExecutionMock: vi.fn(() => false),
  }),
);

vi.mock('../src/infra/ipc.js', () => ({
  enqueueSteeringNote: enqueueSteeringNoteMock,
}));

vi.mock('../src/agent/executor.js', () => ({
  stopSessionExecution: stopSessionExecutionMock,
}));

afterEach(() => {
  enqueueSteeringNoteMock.mockReset();
  stopSessionExecutionMock.mockReset();
  stopSessionExecutionMock.mockImplementation(() => false);
  vi.resetModules();
  vi.restoreAllMocks();
});

test('queues steering notes against active execution session ids', async () => {
  const runtime = await import('../src/gateway/gateway-request-runtime.ts');
  const first = runtime.registerActiveGatewayRequest({
    sessionId: 'session-steer',
    executionSessionId: 'exec-a',
  });
  const second = runtime.registerActiveGatewayRequest({
    sessionId: 'session-steer',
    executionSessionId: 'exec-a',
  });
  const third = runtime.registerActiveGatewayRequest({
    sessionId: 'session-steer',
    executionSessionId: 'exec-b',
  });

  try {
    expect(
      runtime.enqueueGatewaySessionSteeringNote({
        sessionId: 'session-steer',
        note: 'Use the smaller diff first.',
      }),
    ).toEqual({
      queued: 2,
      executionSessionIds: ['exec-a', 'exec-b'],
    });
    expect(enqueueSteeringNoteMock).toHaveBeenCalledTimes(2);
    expect(enqueueSteeringNoteMock).toHaveBeenNthCalledWith(
      1,
      'exec-a',
      'Use the smaller diff first.',
    );
    expect(enqueueSteeringNoteMock).toHaveBeenNthCalledWith(
      2,
      'exec-b',
      'Use the smaller diff first.',
    );
  } finally {
    first.release();
    second.release();
    third.release();
  }
});

test('returns an empty steering queue result when the session is idle', async () => {
  const runtime = await import('../src/gateway/gateway-request-runtime.ts');

  expect(
    runtime.enqueueGatewaySessionSteeringNote({
      sessionId: 'session-idle',
      note: 'Try a smaller batch.',
    }),
  ).toEqual({
    queued: 0,
    executionSessionIds: [],
  });
  expect(enqueueSteeringNoteMock).not.toHaveBeenCalled();
});
