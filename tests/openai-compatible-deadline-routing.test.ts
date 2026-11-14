import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { expect, test, vi } from 'vitest';
import type { GatewayChatRequest } from '../src/gateway/gateway-types.js';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { handleChat } = vi.hoisted(() => ({ handleChat: vi.fn() }));
vi.mock('../src/gateway/gateway-chat-service.js', () => ({
  handleGatewayMessage: handleChat,
}));
const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'api-deadline-',
  cleanup: () => handleChat.mockReset(),
});

test.each(['bound', 'no header', 'expired body', 'decision'] as const)(
  'the real API handler routes %s execution budgets',
  async (phase) => {
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
    const initial = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(initial);
    const req = Object.assign(
      Readable.from(
        (async function* () {
          if (phase === 'expired body')
            vi.mocked(Date.now).mockReturnValue(initial + 1001);
          yield JSON.stringify({
            model:
              phase === 'decision' ? 'auxiliary/quick_decision' : 'test-model',
            messages: [{ role: 'user', content: 'Read synthetic notes.' }],
          });
        })(),
      ),
      {
        headers:
          phase === 'no header' ? {} : { 'x-hybridclaw-timeout-ms': '1000' },
      },
    ) as unknown as IncomingMessage;
    let status: number | undefined,
      body = '';
    const res = {
      writableEnded: false,
      destroyed: false,
      headersSent: false,
      writeHead: vi.fn((code: number) => {
        status = code;
        res.headersSent = true;
      }),
      write: vi.fn(),
      end: vi.fn((value: string) => {
        body = value;
        res.writableEnded = true;
      }),
    };
    await handleOpenAICompatibleChatCompletions(
      req,
      res as unknown as ServerResponse,
    );
    if (phase === 'bound' || phase === 'no header') {
      expect(status).toBe(200);
      expect(handleChat).toHaveBeenCalledOnce();
      expect(
        (handleChat.mock.calls[0][0] as GatewayChatRequest)
          .executionDeadlineAtMs,
      ).toBe(phase === 'bound' ? initial + 1000 : undefined);
    } else {
      expect(status).toBe(phase === 'decision' ? 400 : 408);
      expect(handleChat).not.toHaveBeenCalled();
      expect(JSON.parse(body).error.code).toBe(
        phase === 'decision'
          ? 'unsupported_value'
          : 'execution_deadline_exceeded',
      );
    }
  },
);
