import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { Session } from '../src/types/session.js';
import { useCleanMocks } from './test-utils.js';

const state = vi.hoisted(() => ({
  sessions: [] as Array<Pick<Session, 'id' | 'session_key' | 'channel_id'>>,
  references: new Map<string, unknown>(),
  send: vi.fn(),
  buildAttachments: vi.fn(),
}));

vi.mock('../src/memory/db.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getAllSessions: () => state.sessions,
}));
vi.mock('../src/channels/channel-runtime-loaders.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  msteamsRuntimeLoader: {
    load: async () => ({
      readStoredConversationReference: (key: string) =>
        state.references.get(key) ?? null,
      sendViaConversationReference: state.send,
    }),
  },
  msteamsAttachmentsLoader: {
    load: async () => ({
      buildTeamsArtifactAttachments: state.buildAttachments,
    }),
  },
}));
vi.mock('../src/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

useCleanMocks();

const { sendProactive } = await import('../src/channels/msteams/proactive.js');

function storedReference(conversationId: string, isDm = false) {
  return {
    channelId: conversationId,
    isDm,
    replyStyle: 'thread' as const,
    replyToId: 'msg-1',
    reference: {
      bot: { id: 'bot-id' },
      channelId: 'msteams',
      conversation: { id: conversationId },
      serviceUrl: 'https://service.example.com/',
    },
  };
}

function addTeamsSession(sessionKey: string, conversationId: string): void {
  state.sessions.push({
    id: `sess_${state.sessions.length}`,
    session_key: sessionKey,
    channel_id: conversationId,
  });
}

beforeEach(() => {
  state.sessions = [];
  state.references.clear();
  state.send
    .mockReset()
    .mockImplementation(async (_stored, prepare) => {
      const prepared = await prepare({ activity: {} });
      return prepared.attachments?.length ?? 0;
    });
  state.buildAttachments.mockReset();
});

describe('Microsoft Teams proactive delivery', () => {
  test('sends through the reference stored for the target conversation', async () => {
    const key = 'agent:main:channel:msteams:chat:dm:peer:user-1';
    addTeamsSession(key, 'a:personal-chat');
    const stored = storedReference('a:personal-chat', true);
    state.references.set(key, stored);

    expect(
      await sendProactive('a:personal-chat', 'Report ready', 'schedule:1'),
    ).toEqual({ status: 'delivered' });
    expect(state.send).toHaveBeenCalledWith(stored, expect.any(Function));
    const prepared = await state.send.mock.calls[0][1]({});
    expect(prepared).toEqual({ text: 'Report ready' });
  });

  test('posts top-level to a team channel through a stored thread reference', async () => {
    const key = 'agent:main:channel:msteams:chat:channel:peer:team-1';
    addTeamsSession(key, '19:team@thread.tacv2;messageid=99');
    state.references.set(
      key,
      storedReference('19:team@thread.tacv2;messageid=99'),
    );

    await sendProactive('19:team@thread.tacv2', 'Alert', 'schedule:2');
    expect(state.send.mock.calls[0][0]).toMatchObject({
      channelId: '19:team@thread.tacv2',
      replyStyle: 'top-level',
      replyToId: null,
      reference: { conversation: { id: '19:team@thread.tacv2' } },
    });
  });

  test.each([
    ['an unseen conversation', '19:unseen@thread.v2'],
    ['a different thread of a seen channel', '19:team@thread.tacv2;messageid=1'],
  ])('fails without a stored reference for %s', async (_label, target) => {
    const key = 'agent:main:channel:msteams:chat:channel:peer:team-1';
    addTeamsSession(key, '19:team@thread.tacv2;messageid=99');
    state.references.set(key, storedReference('19:team@thread.tacv2'));

    const outcome = await sendProactive(target, 'hello', 'schedule:1');
    expect(outcome.status).toBe('failed');
    expect(outcome.reason).toContain('No stored Microsoft Teams conversation');
    expect(state.send).not.toHaveBeenCalled();
  });

  test('explains a stale reference when Teams rejects the conversation', async () => {
    const key = 'agent:main:channel:msteams:chat:dm:peer:user-1';
    addTeamsSession(key, 'a:personal-chat');
    state.references.set(key, storedReference('a:personal-chat', true));
    state.send.mockRejectedValueOnce(
      Object.assign(new Error('Conversation not found'), { statusCode: 404 }),
    );
    const outcome = await sendProactive('a:personal-chat', 'hi', 'schedule:1');
    expect(outcome.status).toBe('failed');
    expect(outcome.reason).toContain('Conversation not found');
    expect(outcome.reason).toContain('may be stale');

    state.send.mockRejectedValueOnce(new Error('socket hang up'));
    await expect(
      sendProactive('a:personal-chat', 'hi', 'schedule:1'),
    ).rejects.toThrow('socket hang up');
  });

  test('attaches artifacts and falls back to a notice when Teams cannot', async () => {
    const key = 'agent:main:channel:msteams:chat:dm:peer:user-1';
    addTeamsSession(key, 'a:personal-chat');
    state.references.set(key, storedReference('a:personal-chat', true));
    const artifacts = [
      { path: '/tmp/report.pdf', filename: 'report.pdf', mimeType: 'application/pdf' },
    ];
    const attachment = { contentType: 'application/pdf', name: 'report.pdf' };
    state.buildAttachments.mockResolvedValueOnce([attachment]);
    await sendProactive('a:personal-chat', 'Report', 'schedule:1', artifacts);
    expect(await state.send.mock.results[0].value).toBe(1);

    state.buildAttachments.mockRejectedValue(new Error('no file consent'));
    await sendProactive('a:personal-chat', 'Report', 'schedule:1', artifacts);
    const prepared = await state.send.mock.calls[1][1]({});
    expect(prepared.attachments).toBeUndefined();
    expect(prepared.text).toMatch(/^Report\n\n.+supportsFiles/s);
  });
});
