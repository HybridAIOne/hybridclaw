import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { REASONING_EFFORTS } from '@hybridclaw/contracts/reasoning-effort';
import { expect, test, vi } from 'vitest';
import type { GatewayChatRequest } from '../src/gateway/gateway-types.js';
import { readOpenAICompatibleChatRequest } from '../src/gateway/openai-compatible-request.js';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { handleChat } = vi.hoisted(() => ({ handleChat: vi.fn() }));
vi.mock('../src/gateway/gateway-chat-service.js', () => ({
  handleGatewayMessage: handleChat,
}));
const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'api-reasoning-',
  cleanup: () => handleChat.mockReset(),
});

function request(options: Record<string, unknown> = {}): IncomingMessage {
  return Object.assign(
    Readable.from([
      JSON.stringify({
        model: 'test-model',
        messages: [{ role: 'user', content: 'Read synthetic notes.' }],
        ...options,
      }),
    ]),
    { headers: {} },
  ) as unknown as IncomingMessage;
}

test.each(REASONING_EFFORTS)('parses canonical effort %s', async (effort) => {
  expect(
    await readOpenAICompatibleChatRequest(
      request({ reasoning_effort: effort }),
    ),
  ).toHaveProperty('reasoningEffort', effort);
});

test.each([null, true, 1, {}, [], '', 'HIGH', 'unsupported'])(
  'rejects malformed effort %j',
  async (effort) => {
    await expect(
      readOpenAICompatibleChatRequest(request({ reasoning_effort: effort })),
    ).rejects.toMatchObject({ statusCode: 400, param: 'reasoning_effort' });
  },
);

test('rejects effort on client-managed tool calls', async () => {
  await expect(
    readOpenAICompatibleChatRequest(
      request({
        reasoning_effort: 'medium',
        tool_choice: 'auto',
      }),
    ),
  ).rejects.toMatchObject({ statusCode: 400, param: 'reasoning_effort' });
});

test.each([
  { effort: undefined, stream: false },
  { effort: 'none', stream: false },
  { effort: 'medium', stream: false },
  {
    effort: 'medium',
    stream: false,
    model: 'test-model__hc_eval=current-agent',
  },
  { effort: 'high', stream: true },
  { effort: 'invalid', stream: false },
  { effort: 'medium', stream: false, model: 'auxiliary/quick_decision' },
])(
  'routes effort without changing permissions: %j',
  async ({ effort, stream, model }) => {
    const home = setupHome();
    const { initDatabase } = await import('../src/memory/db.js');
    initDatabase({ quiet: true, dbPath: path.join(home, 'history.db') });
    const { handleOpenAICompatibleChatCompletions } = await import(
      '../src/gateway/openai-compatible.js'
    );
    handleChat.mockResolvedValue({
      status: 'success',
      result: 'Synthetic reply.',
      toolsUsed: [],
    });
    let status: number | undefined;
    const res = {
      writableEnded: false,
      destroyed: false,
      headersSent: false,
      writeHead: vi.fn((code: number) => {
        status = code;
        res.headersSent = true;
      }),
      write: vi.fn(),
      end: vi.fn(() => {
        res.writableEnded = true;
      }),
    };
    await handleOpenAICompatibleChatCompletions(
      request({
        reasoning_effort: effort,
        stream,
        ...(model ? { model } : {}),
      }),
      res as unknown as ServerResponse,
    );
    if (model?.startsWith('auxiliary/') || effort === 'invalid') {
      expect(status).toBe(400);
      expect(handleChat).not.toHaveBeenCalled();
    } else {
      expect(status).toBe(200);
      expect(handleChat).toHaveBeenCalledOnce();
      const call = handleChat.mock.calls[0][0] as GatewayChatRequest;
      expect(call.reasoningEffort).toBe(effort);
      expect(call.autoApproveTools).toBe(
        model?.includes('__hc_eval=') ? true : undefined,
      );
    }
  },
);
