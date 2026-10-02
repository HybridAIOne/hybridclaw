import { PassThrough } from 'node:stream';
import { expect, test, vi } from 'vitest';

import { encodeWarmWorkerFrame } from '../container/shared/warm-worker-frame.js';
import { createLineReader, readFirstInput } from '../container/src/stdin.js';

const SERVERS = {
  docs: { transport: 'http', url: 'https://example.com/mcp' },
};
const REQUEST = { sessionId: 'session_a', messages: [] };

test('keeps the bytes after a newline for the next read', async () => {
  const stream = new PassThrough();
  const readLine = createLineReader(stream);
  stream.write('first\nsecond\nthi');

  await expect(readLine()).resolves.toBe('first');
  await expect(readLine()).resolves.toBe('second');
  const third = readLine();
  stream.write('rd\n');
  await expect(third).resolves.toBe('third');
});

test('a warm frame starts connecting MCP before the first request arrives', async () => {
  const stream = new PassThrough();
  const connectMcp = vi.fn(async () => undefined);
  stream.write(encodeWarmWorkerFrame(SERVERS));

  const firstInput = readFirstInput(createLineReader(stream), connectMcp);
  await vi.waitFor(() => expect(connectMcp).toHaveBeenCalledWith(SERVERS));
  stream.write(`${JSON.stringify(REQUEST)}\n`);

  await expect(firstInput).resolves.toEqual(REQUEST);
});

test('a warm frame and the first request may share one chunk', async () => {
  const stream = new PassThrough();
  const connectMcp = vi.fn(async () => {
    throw new Error('connect failed');
  });
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  stream.write(
    `${encodeWarmWorkerFrame(SERVERS)}${JSON.stringify(REQUEST)}\n`,
  );

  await expect(
    readFirstInput(createLineReader(stream), connectMcp),
  ).resolves.toEqual(REQUEST);
  // A failed warm connect is logged; the first request still runs.
  await vi.waitFor(() => expect(error).toHaveBeenCalled());
  error.mockRestore();
});

test('a first line without a warm frame is the request', async () => {
  const stream = new PassThrough();
  const connectMcp = vi.fn(async () => undefined);
  stream.write(`${JSON.stringify({ ...REQUEST, mcpServers: SERVERS })}\n`);

  await expect(
    readFirstInput(createLineReader(stream), connectMcp),
  ).resolves.toEqual({ ...REQUEST, mcpServers: SERVERS });
  expect(connectMcp).not.toHaveBeenCalled();
});
