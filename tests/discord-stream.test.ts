import { afterEach, describe, expect, test, vi } from 'vitest';

async function importFreshStream() {
  vi.resetModules();

  const chunkMessage = vi.fn<(text: string) => string[]>();
  const getHumanDelayMs = vi.fn(() => 0);
  const sleep = vi.fn(async () => {});
  const logDiscordApiError = vi.fn();
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
  vi.doMock('../src/channels/discord/transport-errors.js', () => ({
    logDiscordApiError,
  }));

  const stream = await import('../src/channels/discord/stream.js');
  return {
    stream,
    chunkMessage,
    getHumanDelayMs,
    sleep,
    logger,
    logDiscordApiError,
  };
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
  vi.doUnmock('../src/channels/discord/transport-errors.js');
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
    expect(chunkMessage).toHaveBeenCalledWith('ignored', {
      maxChars: 1_900,
      maxLines: 20,
    });
  });

  test('continues streaming after one chunk fails and still attaches files', async () => {
    const { stream, chunkMessage, logDiscordApiError } =
      await importFreshStream();
    chunkMessage.mockReturnValue(['bad chunk', 'final chunk']);
    const files = [{ name: 'report.txt' }] as unknown as [];
    const sentMessage = makeSentMessage();

    const reply = vi.fn(async () => {
      throw new Error('bad chunk');
    });
    const send = vi.fn(async () => sentMessage);
    const manager = new stream.DiscordStreamManager({
      reply,
      channel: { send },
    } as never);

    await manager.finalize('ignored', files);

    expect(send).toHaveBeenCalledWith({ content: 'final chunk' });
    expect(sentMessage.edit).toHaveBeenCalledWith({
      content: 'final chunk',
      files,
    });
    expect(logDiscordApiError).toHaveBeenCalledWith(
      expect.objectContaining({
        unexpectedMessage: 'Failed to send Discord stream chunk',
        metadata: { chunkIndex: 1, chunkCount: 2 },
      }),
    );
  });
});
