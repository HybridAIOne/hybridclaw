import { expect, test, vi } from 'vitest';
import { useCleanMocks } from './test-utils.ts';

const mocks = vi.hoisted(() => ({
  initDiscord: vi.fn(),
  handleGatewayMessage: vi.fn(),
  handlePendingApprovalRouting: vi.fn(),
  deliverProactiveMessage: vi.fn(),
}));

vi.mock('../src/config/config.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  DISCORD_TOKEN: 'test-token',
}));
vi.mock('../src/channels/channel-runtime-loaders.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  discordRuntimeLoader: {
    loadForStart: async () => ({ initDiscord: mocks.initDiscord }),
  },
}));
vi.mock('../src/gateway/gateway-chat-service.js', () => ({
  handleGatewayMessage: mocks.handleGatewayMessage,
}));
vi.mock('../src/gateway/proactive-dispatch.js', () => ({
  deliverProactiveMessage: mocks.deliverProactiveMessage,
}));
vi.mock('../src/gateway/channel-message.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  handlePendingApprovalRouting: mocks.handlePendingApprovalRouting,
}));

useCleanMocks({
  resetModules: true,
  cleanup: () => {
    for (const mock of Object.values(mocks)) mock.mockReset();
  },
});

const APPROVAL = {
  type: 'approval' as const,
  approvalId: 'appr-1',
  prompt: 'Approve create_file?',
  intent: 'create a file',
  reason: 'writes outside',
  summary: 'Approval ID: appr-1',
  allowSession: true,
  allowAgent: true,
  allowAll: true,
  expiresAt: null,
};

test.each([
  ['routes an approval in the same channel to buttons', APPROVAL, 'chan-1', 1],
  ['delivers plain proactive text as before', undefined, undefined, 0],
  ['delivers an approval for another channel as text', APPROVAL, 'chan-2', 0],
])('discord delegate follow-up %s', async (_name, approval, targetChannel, routed) => {
  mocks.handleGatewayMessage.mockImplementation(async (req) => {
    await req.onProactiveMessage({
      channelId: targetChannel,
      text: 'parent reply',
      approval,
    });
    // The proactive callback is what this test covers; end the turn early.
    return { status: 'error', result: null, toolsUsed: [], error: 'done' };
  });
  const { startDiscordIntegration } = await import(
    '../src/channels/discord/gateway.ts'
  );
  await startDiscordIntegration();
  const handler = mocks.initDiscord.mock.calls[0]?.[0];
  const sendApprovalNotification = vi.fn();
  const stream = { append: vi.fn(), fail: vi.fn() };
  await handler('sess-1', null, 'chan-1', 'user-1', 'user', 'hi', [], vi.fn(), {
    stream,
    emitLifecyclePhase: vi.fn(),
    sendApprovalNotification,
  });

  expect(mocks.handlePendingApprovalRouting).toHaveBeenCalledTimes(routed);
  if (routed) {
    expect(mocks.handlePendingApprovalRouting).toHaveBeenCalledWith(
      expect.objectContaining({
        pendingApproval: APPROVAL,
        sessionId: 'sess-1',
        userId: 'user-1',
        channelId: 'chan-1',
        sendApprovalNotification,
      }),
    );
    expect(mocks.deliverProactiveMessage).not.toHaveBeenCalled();
  } else {
    expect(mocks.deliverProactiveMessage).toHaveBeenCalledWith(
      targetChannel || 'chan-1',
      'parent reply',
      'delegate',
      undefined,
    );
  }
});
