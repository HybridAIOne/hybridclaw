import { afterEach, expect, test, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

test('keeps Telegram typing alive until the turn completes', async () => {
  vi.useFakeTimers();

  const { createTelegramTypingController } = await import(
    '../src/channels/telegram/typing.js'
  );

  const sendTyping = vi.fn(async () => true);
  const controller = createTelegramTypingController(sendTyping, {
    keepaliveMs: 4_000,
    ttlMs: 20_000,
  });

  controller.start();
  await Promise.resolve();

  expect(sendTyping).toHaveBeenCalledTimes(1);

  sendTyping.mockClear();
  await vi.advanceTimersByTimeAsync(4_000);
  expect(sendTyping).toHaveBeenCalledTimes(1);

  sendTyping.mockClear();
  controller.stop();
  await vi.advanceTimersByTimeAsync(8_000);
  expect(sendTyping).not.toHaveBeenCalled();
});
