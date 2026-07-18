import { afterEach, expect, test, vi } from 'vitest';
import { createWhatsAppTestHost } from './whatsapp-test-host.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

test('keeps WhatsApp composing presence alive until the turn completes', async () => {
  vi.useFakeTimers();

  const { createWhatsAppTypingController } = await import(
    '../plugins/whatsapp/src/typing.js'
  );

  const socket = {
    sendPresenceUpdate: vi.fn(async () => {}),
  };
  const controller = createWhatsAppTypingController(
    createWhatsAppTestHost(),
    () => socket,
    '491701234567@s.whatsapp.net',
    {
      keepaliveMs: 5_000,
      ttlMs: 20_000,
    },
  );

  controller.start();
  await Promise.resolve();

  expect(socket.sendPresenceUpdate).toHaveBeenCalledWith(
    'composing',
    '491701234567@s.whatsapp.net',
  );

  socket.sendPresenceUpdate.mockClear();
  await vi.advanceTimersByTimeAsync(5_000);
  expect(socket.sendPresenceUpdate).toHaveBeenCalledWith(
    'composing',
    '491701234567@s.whatsapp.net',
  );

  socket.sendPresenceUpdate.mockClear();
  controller.stop();
  await Promise.resolve();

  expect(socket.sendPresenceUpdate).toHaveBeenCalledWith(
    'paused',
    '491701234567@s.whatsapp.net',
  );
});
