import type { IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';
import { beforeEach, expect, test, vi } from 'vitest';
import { readOpenAICompatibleChatRequest } from '../src/gateway/openai-compatible-request.js';
import { useCleanMocks } from './test-utils.js';

const now = 1_700_000_000_000;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
});
useCleanMocks({ cleanup: () => vi.useRealTimers() });

function request(
  value?: string | string[],
  options: Record<string, unknown> = {},
  beforeBody?: () => void,
) {
  const body = JSON.stringify({
    model: 'test-model',
    messages: [{ role: 'user', content: 'Read synthetic notes.' }],
    ...options,
  });
  const stream = Readable.from(
    (async function* () {
      beforeBody?.();
      yield body;
    })(),
  );
  return Object.assign(stream, {
    headers: value === undefined ? {} : { 'x-hybridclaw-timeout-ms': value },
  }) as unknown as IncomingMessage;
}

test('a timeout starts before body preparation and remains absolute', async () => {
  const result = await readOpenAICompatibleChatRequest(
    request('1000', {}, () => vi.setSystemTime(now + 200)),
  );
  expect(result).toHaveProperty('executionDeadlineAtMs', now + 1000);
});

test('omitting the header preserves the existing request contract', async () => {
  expect(await readOpenAICompatibleChatRequest(request())).not.toHaveProperty(
    'executionDeadlineAtMs',
    expect.any(Number),
  );
});

test('body preparation cannot renew an elapsed request budget', async () => {
  await expect(
    readOpenAICompatibleChatRequest(
      request('1000', {}, () => vi.setSystemTime(now + 1001)),
    ),
  ).rejects.toMatchObject({
    statusCode: 408,
    code: 'execution_deadline_exceeded',
  });
});

test.each([
  '0',
  '-1',
  '1.5',
  '',
  ' ',
  'Infinity',
  'NaN',
  '0xFF',
  '1000,2000',
  String(Number.MAX_SAFE_INTEGER),
  ['1000', '2000'],
])(
  'rejects an invalid timeout header %j before consuming the body',
  async (value) => {
    const readBody = vi.fn();
    await expect(
      readOpenAICompatibleChatRequest(request(value, {}, readBody)),
    ).rejects.toMatchObject({
      statusCode: 400,
      param: 'X-HybridClaw-Timeout-Ms',
    });
    expect(readBody).not.toHaveBeenCalled();
  },
);

test.each([
  { tool_choice: 'auto' },
  {
    tools: [
      {
        type: 'function',
        function: {
          name: 'lookup',
          parameters: { type: 'object', properties: {} },
        },
      },
    ],
  },
])(
  'client-managed calls reject unsupported deadline promises',
  async (options) => {
    await expect(
      readOpenAICompatibleChatRequest(request('1000', options)),
    ).rejects.toMatchObject({ statusCode: 400, code: 'unsupported_value' });
  },
);
