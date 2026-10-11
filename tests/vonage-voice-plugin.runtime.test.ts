import { Readable } from 'node:stream';
import { expect, test, vi } from 'vitest';

vi.mock('../plugins/vonage-voice/src/jwt.js', () => ({
  extractBearerToken: () => 'test-token',
  verifyVonageWebhookJwt: () => ({ jti: crypto.randomUUID() }),
  WEBHOOK_JWT_MAX_AGE_SECONDS: 300,
}));
vi.mock('../plugins/vonage-voice/src/api.js', () => ({
  transferVonageCallToNcco: vi.fn(async () => {}),
}));

const { createVonageRuntime } = await import(
  '../plugins/vonage-voice/src/runtime.js'
);

function webhookCtx(body: Record<string, unknown>) {
  return {
    req: Object.assign(Readable.from([JSON.stringify(body)]), {
      headers: { authorization: 'Bearer test-token' },
    }),
    res: { statusCode: 0, setHeader: vi.fn(), end: vi.fn() },
    logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
    webhookName: 'test',
  };
}

// The default agent is read live, not from the registration-time config
// snapshot, and a call keeps the agent it was answered with.
test('each call keeps the default agent that was live when it was answered', async () => {
  const agents = { defaultAgentId: 'main' };
  const dispatchInboundMessage = vi.fn(
    async (_request: { agentId: string; sessionId: string }) => ({
      result: 'Done.',
    }),
  );
  const runtime = createVonageRuntime(
    {
      getDefaultAgentId: () => agents.defaultAgentId,
      dispatchInboundMessage,
      isRealtimeVoiceAvailable: () => false,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    },
    {
      applicationId: 'app-id',
      privateKey: 'test-key',
      signatureSecret: 'test-secret',
      publicBaseUrl: 'https://voice.example.com',
      callerPolicy: 'open',
      allowFrom: [],
      maxConcurrentCalls: 8,
      mode: 'turn',
    },
  );

  await runtime.handleAnswer(webhookCtx({ uuid: 'call-1', from: '+15550001111' }));
  agents.defaultAgentId = 'support';
  await runtime.handleAnswer(webhookCtx({ uuid: 'call-2', from: '+15550001111' }));
  for (const uuid of ['call-1', 'call-2']) {
    await runtime.handleInput(
      webhookCtx({ uuid, speech: { results: [{ text: 'Hi' }] } }),
    );
  }
  await vi.waitFor(() =>
    expect(dispatchInboundMessage).toHaveBeenCalledTimes(2),
  );

  expect(
    dispatchInboundMessage.mock.calls.map(([request]) => [
      request.agentId,
      request.sessionId,
    ]),
  ).toEqual([
    ['main', expect.stringContaining('agent:main:')],
    ['support', expect.stringContaining('agent:support:')],
  ]);
});
