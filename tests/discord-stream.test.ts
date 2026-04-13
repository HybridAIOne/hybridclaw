import { afterEach, describe, expect, test, vi } from 'vitest';

async function importFreshStream() {
  vi.resetModules();

  const chunkMessage = vi.fn<(text: string) => string[]>();
  const getHumanDelayMs = vi.fn(() => 0);
  const sleep = vi.fn(async () => {});
  const logger = {
    warn: vi.fn(),
    debug: vi.fn(),
  };

  vi.doMock('../src/config/config.ts', () => ({
    DISCORD_MAX_LINES_PER_MESSAGE: 20,
    DISCORD_TEXT_CHUNK_LIMIT: 1_900,
  }));
  vi.doMock('../src/memory/chunk.js', () => ({
    chunkMessage,
  }));
  vi.doMock('../src/channels/discord/human-delay.js', () => ({
    getHumanDelayMs,
  }));
  vi.doMock('../src/utils/sleep.js', () => ({
    sleep,
  }));
  vi.doMock('../src/logger.ts', () => ({
    logger,
  }));

  const stream = await import('../src/channels/discord/stream.js');
  return { stream, chunkMessage, getHumanDelayMs, sleep, logger };
}

function makeSentMessage() {
  return {
    edit: vi.fn(async () => makeSentMessage()),
    delete: vi.fn(async () => undefined),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock('../src/config/config.ts');
  vi.doUnmock('../src/memory/chunk.js');
  vi.doUnmock('../src/channels/discord/human-delay.js');
  vi.doUnmock('../src/utils/sleep.js');
  vi.doUnmock('../src/logger.ts');
  vi.resetModules();
});

describe('DiscordStreamManager', () => {
  test('skips blank-only chunks before sending streamed replies', async () => {
    const { stream, chunkMessage } = await importFreshStream();
    chunkMessage.mockReturnValue(['\n', 'visible chunk']);

    const reply = vi.fn(async () => makeSentMessage());
    const send = vi.fn(async () => makeSentMessage());
    const manager = new stream.DiscordStreamManager({
      reply,
      channel: { send },
    } as never);

    await manager.finalize('ignored');

    expect(reply).toHaveBeenCalledWith({ content: 'visible chunk' });
    expect(send).not.toHaveBeenCalled();
  });
});
