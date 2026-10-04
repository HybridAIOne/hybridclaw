import { afterEach, describe, expect, test, vi } from 'vitest';

import { createTypingController } from '../src/channels/discord/typing.ts';

function makeMessage(sendTyping: () => Promise<void>) {
  return {
    channelId: 'channel_a',
    channel: { sendTyping: vi.fn(sendTyping) },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('createTypingController', () => {
  test('stops the keepalive as soon as the reply phase starts', () => {
    vi.useFakeTimers();
    const message = makeMessage(async () => {});
    const controller = createTypingController(message as never, 'thinking');

    controller.setPhase('thinking');
    vi.advanceTimersByTime(8_000);
    expect(message.channel.sendTyping).toHaveBeenCalledTimes(2);

    controller.setPhase('streaming');
    vi.advanceTimersByTime(30_000);
    expect(message.channel.sendTyping).toHaveBeenCalledTimes(2);
  });

  test('settled waits for the in-flight typing request', async () => {
    let resolveTyping = () => {};
    const message = makeMessage(
      () =>
        new Promise<void>((resolve) => {
          resolveTyping = resolve;
        }),
    );
    const controller = createTypingController(message as never, 'thinking');
    controller.setPhase('toolUse');
    controller.setPhase('streaming');

    let settled = false;
    const done = controller.settled().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    resolveTyping();
    await done;
    expect(settled).toBe(true);
  });

  test('settled resolves when the typing request fails', async () => {
    const message = makeMessage(async () => {
      throw new Error('typing failed');
    });
    const controller = createTypingController(message as never, 'instant');
    controller.setPhase('received');

    await expect(controller.settled()).resolves.toBeUndefined();
  });
});
