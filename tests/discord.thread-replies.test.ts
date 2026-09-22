import { PermissionFlagsBits } from 'discord.js';
import { describe, expect, test, vi } from 'vitest';
import {
  deriveDiscordThreadName,
  resolveDiscordParentChannelId,
  resolveDiscordReplyChannel,
} from '../src/channels/discord/thread-replies.js';

function makeMessage(options?: {
  hasThread?: boolean;
  isThread?: boolean;
  missingPermission?: bigint;
}) {
  const thread = { send: vi.fn() };
  const startThread = vi.fn(async () => thread);
  const message = {
    id: '323456789012345678',
    channelId: '223456789012345678',
    content: '  Please   investigate this incident  ',
    cleanContent: '  Please   investigate this incident  ',
    author: { username: 'user_a' },
    channel: {
      parentId: options?.isThread ? '123456789012345678' : null,
      isThread: () => options?.isThread ?? false,
      permissionsFor: () => ({
        has: (flag: bigint) => flag !== options?.missingPermission,
      }),
    },
    guild: {
      members: {
        me: {},
        fetchMe: vi.fn(),
      },
      channels: {
        fetch: vi.fn(async () => thread),
      },
    },
    hasThread: options?.hasThread ?? false,
    thread: options?.hasThread ? thread : null,
    startThread,
  };
  return { message, startThread, thread };
}

describe('Discord thread replies', () => {
  test('derives a compact thread name from the triggering message', () => {
    const { message } = makeMessage();
    expect(deriveDiscordThreadName(message as never)).toBe(
      'Please investigate this incident',
    );
  });

  test('reuses the thread already attached to the triggering message', async () => {
    const { message, startThread, thread } = makeMessage({ hasThread: true });
    const result = await resolveDiscordReplyChannel({
      message: message as never,
      replyStyle: 'thread',
    });
    expect(result).toEqual({ channel: thread });
    expect(startThread).not.toHaveBeenCalled();
  });

  test('creates a thread for a guild message when permissions allow it', async () => {
    const { message, startThread, thread } = makeMessage();
    const result = await resolveDiscordReplyChannel({
      message: message as never,
      replyStyle: 'thread',
    });
    expect(result).toEqual({ channel: thread });
    expect(startThread).toHaveBeenCalledWith({
      name: 'Please investigate this incident',
      reason: 'HybridClaw thread reply',
    });
  });

  test('falls back when thread permissions are missing', async () => {
    const { message, startThread } = makeMessage({
      missingPermission: PermissionFlagsBits.CreatePublicThreads,
    });
    const result = await resolveDiscordReplyChannel({
      message: message as never,
      replyStyle: 'thread',
    });
    expect(result.channel).toBeNull();
    expect(result.warning).toContain('CreatePublicThreads');
    expect(startThread).not.toHaveBeenCalled();
  });

  test('uses the parent channel id for thread configuration', () => {
    const { message } = makeMessage({ isThread: true });
    expect(resolveDiscordParentChannelId(message as never)).toBe(
      '123456789012345678',
    );
  });
});
