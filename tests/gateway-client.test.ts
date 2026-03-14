import { afterEach, expect, test, vi } from 'vitest';

async function importGatewayClient() {
  vi.resetModules();
  vi.doMock('../src/config/config.js', () => ({
    GATEWAY_API_TOKEN: '',
    GATEWAY_BASE_URL: 'http://gateway.test',
  }));
  return import('../src/gateway/gateway-client.js');
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.doUnmock('../src/config/config.js');
});

test('gatewayChatStream parses approval events before the final result', async () => {
  const encoder = new TextEncoder();
  const payload = `${JSON.stringify({
    type: 'approval',
    approvalId: 'approve123',
    prompt: 'I need your approval before I control a local app.',
    intent: 'control a local app with `open -a Music`',
    reason: 'this command controls host GUI or application state',
    allowSession: true,
    allowAgent: false,
    expiresAt: 1_710_000_000_000,
  })}\n${JSON.stringify({
    type: 'result',
    result: {
      status: 'success',
      result: 'I need your approval before I control a local app.',
      toolsUsed: ['bash'],
      pendingApproval: {
        approvalId: 'approve123',
        prompt: 'I need your approval before I control a local app.',
        intent: 'control a local app with `open -a Music`',
        reason: 'this command controls host GUI or application state',
        allowSession: true,
        allowAgent: false,
        expiresAt: 1_710_000_000_000,
      },
    },
  })}\n`;
  const splitAt = Math.floor(payload.length / 2);
  const chunks = [payload.slice(0, splitAt), payload.slice(splitAt)];
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(stream, { status: 200 })),
  );

  const { gatewayChatStream } = await importGatewayClient();
  const events: unknown[] = [];

  const result = await gatewayChatStream(
    {
      sessionId: 's1',
      guildId: null,
      channelId: 'web',
      userId: 'user-1',
      username: 'web',
      content: 'play music',
      stream: true,
    },
    (event) => {
      events.push(event);
    },
  );

  expect(events).toEqual([
    {
      type: 'approval',
      approvalId: 'approve123',
      prompt: 'I need your approval before I control a local app.',
      intent: 'control a local app with `open -a Music`',
      reason: 'this command controls host GUI or application state',
      allowSession: true,
      allowAgent: false,
      expiresAt: 1_710_000_000_000,
    },
  ]);
  expect(result).toMatchObject({
    status: 'success',
    result: 'I need your approval before I control a local app.',
  });
});
