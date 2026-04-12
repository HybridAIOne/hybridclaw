import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

const tempFiles: string[] = [];

function makeTempFile(name: string, content: string): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-slack-runtime-'),
  );
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, content);
  tempFiles.push(filePath);
  return filePath;
}

async function importFreshSlackRuntime() {
  vi.resetModules();

  const postMessage = vi.fn(async () => ({ ts: '1710000000.123456' }));
  const update = vi.fn(async () => ({ ok: true }));
  const postEphemeral = vi.fn(async () => ({ ok: true }));
  const uploadV2 = vi.fn(
    async (params?: { file?: { destroy?: () => void } }) => {
      if (params?.file) {
        await once(params.file as NodeJS.EventEmitter, 'open');
        params.file.destroy?.();
      }
      return { ok: true };
    },
  );
  const authTest = vi.fn(async () => ({ user_id: 'U9999999999' }));
  const usersInfo = vi.fn(async () => ({
    user: { profile: { display_name: 'HybridClaw Dev' } },
  }));
  const eventHandlers = new Map<string, (payload: unknown) => Promise<void>>();
  let approvalActionHandler:
    | null
    | ((payload: {
        ack: () => Promise<void>;
        action: Record<string, unknown>;
        body: Record<string, unknown>;
      }) => Promise<void>) = null;
  const event = vi.fn(
    (name: string, handler: (payload: unknown) => Promise<void>) => {
      eventHandlers.set(name, handler);
    },
  );
  const action = vi.fn(
    (
      _matcher: unknown,
      handler: (payload: {
        ack: () => Promise<void>;
        action: Record<string, unknown>;
        body: Record<string, unknown>;
      }) => Promise<void>,
    ) => {
      approvalActionHandler = handler;
    },
  );
  const start = vi.fn(async () => {});
  const registerChannel = vi.fn();
  const chunkMessage = vi.fn((text: string) => [text]);
  const processInboundSlackEvent = vi.fn(async () => null);

  const slackApp = {
    client: {
      auth: {
        test: authTest,
      },
      chat: {
        postMessage,
        postEphemeral,
        update,
      },
      files: {
        uploadV2,
      },
      users: {
        info: usersInfo,
      },
    },
    event,
    action,
    start,
  };

  const App = vi.fn(function MockSlackApp() {
    return slackApp;
  });

  vi.doMock('@slack/bolt', () => ({
    App,
    LogLevel: {
      WARN: 'warn',
    },
  }));
  vi.doMock('../src/config/config.ts', () => ({
    SLACK_APP_TOKEN: 'xapp-test-token',
    SLACK_BOT_TOKEN: 'xoxb-test-token',
    SLACK_ENABLED: true,
    SLACK_TEXT_CHUNK_LIMIT: 12_000,
  }));
  vi.doMock('../src/config/runtime-config.js', () => ({
    getRuntimeConfig: () => ({
      slack: {
        enabled: true,
        dmPolicy: 'open',
        groupPolicy: 'open',
        allowFrom: [],
        groupAllowFrom: [],
        requireMention: true,
        replyStyle: 'thread',
        mediaMaxMb: 20,
      },
    }),
  }));
  vi.doMock('../src/channels/channel-registry.js', () => ({
    registerChannel,
  }));
  vi.doMock('../src/memory/chunk.js', () => ({
    chunkMessage,
  }));
  vi.doMock('../src/channels/slack/inbound.js', () => ({
    cleanupSlackInboundMedia: vi.fn(async () => {}),
    processInboundSlackEvent,
  }));
  vi.doMock('../src/logger.js', () => ({
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  }));

  const runtime = await import('../src/channels/slack/runtime.js');
  return {
    runtime,
    slackApp,
    postMessage,
    update,
    postEphemeral,
    uploadV2,
    authTest,
    usersInfo,
    event,
    action,
    eventHandlers,
    approvalActionHandler: () => approvalActionHandler,
    start,
    registerChannel,
    chunkMessage,
    processInboundSlackEvent,
    App,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock('@slack/bolt');
  vi.doUnmock('../src/config/config.ts');
  vi.doUnmock('../src/config/runtime-config.js');
  vi.doUnmock('../src/channels/channel-registry.js');
  vi.doUnmock('../src/memory/chunk.js');
  vi.doUnmock('../src/channels/slack/inbound.js');
  vi.doUnmock('../src/logger.js');
  vi.resetModules();

  for (const filePath of tempFiles.splice(0)) {
    const dir = path.dirname(filePath);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('slack runtime', () => {
  test('posts formatted mrkdwn text to Slack', async () => {
    const state = await importFreshSlackRuntime();

    await state.runtime.initSlack(
      async () => {},
      async () => {},
    );
    await state.runtime.sendToSlackTarget(
      'slack:C1234567890',
      '- **General Europe news feed constraints:** blocked.',
    );

    expect(state.postMessage).toHaveBeenCalledWith({
      channel: 'C1234567890',
      text: '- *General Europe news feed constraints:* blocked.',
      mrkdwn: true,
    });
  });

  test('formats Slack file captions before upload', async () => {
    const state = await importFreshSlackRuntime();
    const filePath = makeTempFile('report.txt', 'hello slack');

    await state.runtime.initSlack(
      async () => {},
      async () => {},
    );
    await state.runtime.sendSlackFileToTarget({
      target: 'slack:C1234567890:1710000000.123456',
      filePath,
      caption: '**Pending Approval**\nPlease review.',
    });

    expect(state.uploadV2).toHaveBeenCalledWith(
      expect.objectContaining({
        channel_id: 'C1234567890',
        initial_comment: '*Pending Approval*\nPlease review.',
        thread_ts: '1710000000.123456',
      }),
    );
  });

  test('posts Slack approval prompts and replaces buttons when cleanup runs', async () => {
    const state = await importFreshSlackRuntime();
    state.processInboundSlackEvent.mockResolvedValue({
      sessionId: 'agent:main:channel:slack:chat:dm:peer:u1234567890',
      guildId: null,
      channelId: 'slack:C1234567890:1710000000.000001',
      userId: 'U1234567890',
      content: 'hello',
      media: [],
      target: 'slack:C1234567890:1710000000.000001',
      isDm: false,
      threadTs: '1710000000.000001',
    });

    const messageHandler = vi.fn(
      async (_1, _2, _3, _4, _5, _6, _7, _8, context) => {
        const cleanup = await context.sendApprovalNotification?.({
          approval: {
            approvalId: 'approve123',
            prompt: [
              'I need your approval before I contact reuters.com.',
              'Why: this would contact a new external host',
              'Approval ID: approve123',
              'Reply `yes` to approve once.',
              'Reply `yes for session` to trust this action for this session.',
              'Reply `no` to deny.',
              'Approval expires in 120s.',
            ].join('\n'),
            summary:
              'Approval needed for: contact reuters.com\nWhy: this would contact a new external host\nApproval ID: approve123',
          },
          presentation: {
            mode: 'buttons',
            showText: true,
            showButtons: true,
            showReplyText: false,
          },
          userId: 'U1234567890',
        });
        expect(cleanup).not.toBeNull();
        await cleanup?.disableButtons();
      },
    );

    await state.runtime.initSlack(messageHandler, async () => {});
    const eventHandler = state.eventHandlers.get('message');
    expect(eventHandler).toBeTypeOf('function');

    await eventHandler?.({
      event: {
        channel: 'C1234567890',
        ts: '1710000000.200000',
        type: 'message',
      },
    });

    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C1234567890',
        text: [
          '<@U1234567890> I need your approval before I contact reuters.com.',
          'Why: this would contact a new external host',
          'Approval ID: approve123',
          'Approval expires in 120s.',
        ].join('\n'),
        mrkdwn: true,
        thread_ts: '1710000000.000001',
        blocks: expect.arrayContaining([
          expect.objectContaining({
            type: 'section',
            text: expect.objectContaining({
              text: [
                '<@U1234567890> I need your approval before I contact reuters.com.',
                'Why: this would contact a new external host',
                'Approval ID: approve123',
                'Approval expires in 120s.',
              ].join('\n'),
            }),
          }),
          expect.objectContaining({ type: 'actions' }),
        ]),
      }),
    );
    expect(state.update).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C1234567890',
        ts: '1710000000.123456',
        text: '_Approval request is no longer active._',
        blocks: expect.arrayContaining([
          expect.objectContaining({ type: 'section' }),
          expect.objectContaining({ type: 'context' }),
        ]),
      }),
    );
  });

  test('routes Slack approval button clicks through the command handler and updates the message', async () => {
    const state = await importFreshSlackRuntime();
    const pendingApprovals = await import(
      '../src/gateway/pending-approvals.js'
    );
    await pendingApprovals.rememberPendingApproval({
      sessionId: 'agent:main:channel:slack:chat:dm:peer:u1234567890',
      approvalId: 'approve123',
      prompt: 'Approval required.',
      userId: 'U1234567890',
    });
    const commandHandler = vi.fn(async (_1, _2, _3, _4, _5, _6, reply) => {
      await reply('Approval recorded.');
      await pendingApprovals.clearPendingApproval(
        'agent:main:channel:slack:chat:dm:peer:u1234567890',
      );
    });

    await state.runtime.initSlack(async () => {}, commandHandler);
    const approvalActionHandler = state.approvalActionHandler();
    expect(approvalActionHandler).toBeTypeOf('function');
    const ack = vi.fn(async () => {});

    await approvalActionHandler?.({
      ack,
      action: {
        action_id: 'approve:yes',
        value: 'approve123',
      },
      body: {
        user: { id: 'U1234567890' },
        channel: { id: 'C1234567890' },
        message: {
          ts: '1710000000.123456',
          text: '<@U1234567890> Approval required.',
          thread_ts: '1710000000.000001',
        },
      },
    });

    expect(ack).toHaveBeenCalled();
    expect(commandHandler).toHaveBeenCalledWith(
      'agent:main:channel:slack:chat:dm:peer:u1234567890',
      null,
      'slack:C1234567890:1710000000.000001',
      'U1234567890',
      'HybridClaw Dev',
      ['approve', 'yes', 'approve123'],
      expect.any(Function),
    );
    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C1234567890',
        text: 'Approval recorded.',
        thread_ts: '1710000000.000001',
      }),
    );
    expect(state.update).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C1234567890',
        ts: '1710000000.123456',
        text: '*Approved once by HybridClaw Dev.*',
      }),
    );
  });

  test('rejects Slack approval clicks from other users', async () => {
    const state = await importFreshSlackRuntime();
    const pendingApprovals = await import(
      '../src/gateway/pending-approvals.js'
    );
    await pendingApprovals.rememberPendingApproval({
      sessionId: 'agent:main:channel:slack:chat:dm:peer:u1234567890',
      approvalId: 'approve123',
      prompt: 'Approval required.',
      userId: 'U1234567890',
    });
    const commandHandler = vi.fn(async () => {});

    await state.runtime.initSlack(async () => {}, commandHandler);
    const approvalActionHandler = state.approvalActionHandler();

    await approvalActionHandler?.({
      ack: vi.fn(async () => {}),
      action: {
        action_id: 'approve:yes',
        value: 'approve123',
      },
      body: {
        user: { id: 'U0000000001' },
        channel: { id: 'C1234567890' },
        message: {
          ts: '1710000000.123456',
          text: '<@U1234567890> Approval required.',
        },
      },
    });

    expect(commandHandler).not.toHaveBeenCalled();
    expect(state.postEphemeral).toHaveBeenCalledWith({
      channel: 'C1234567890',
      user: 'U0000000001',
      text: 'Only the requesting user can respond.',
    });
    await pendingApprovals.clearPendingApproval(
      'agent:main:channel:slack:chat:dm:peer:u1234567890',
    );
  });
});
