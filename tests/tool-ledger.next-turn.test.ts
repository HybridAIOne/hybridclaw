import { expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.ts';

const ORIGINAL_HOME = process.env.HOME;
const makeTempHome = useTempDir('hybridclaw-tool-ledger-next-turn-');

useCleanMocks({
  cleanup: () => {
    if (ORIGINAL_HOME === undefined) delete process.env.HOME;
    else process.env.HOME = ORIGINAL_HOME;
  },
  resetModules: true,
});

test('a recorded turn renders its tool ledger into the next prompt', async () => {
  process.env.HOME = makeTempHome();
  vi.resetModules();

  const { initDatabase, getOrCreateSession } = await import(
    '../src/memory/db.ts'
  );
  const { memoryService } = await import('../src/memory/memory-service.ts');
  const { recordSuccessfulTurn } = await import(
    '../src/gateway/gateway-service.ts'
  );
  const { buildConversationContext } = await import(
    '../src/agent/conversation.ts'
  );

  initDatabase({ quiet: true });
  const session = getOrCreateSession(
    'agent:main:channel:web:chat:dm:peer:ledger',
    null,
    'web',
    'main',
  );

  recordSuccessfulTurn({
    sessionId: session.id,
    channelId: 'web',
    agentId: 'main',
    chatbotId: '',
    enableRag: false,
    model: 'openai/gpt-5.4',
    userId: 'user_a',
    username: 'User A',
    canonicalScopeId: 'user_a',
    userContent: 'Send the report to +49 151',
    resultText: 'Sent.',
    toolCallCount: 2,
    toolExecutions: [
      {
        name: 'message',
        arguments: '{"action":"send","channel":"whatsapp","to":"+49 151"}',
        result: '{"ok":false,"error":"WhatsApp is not linked"}',
        isError: false,
      },
      {
        name: 'write',
        arguments: '{"path":"report.md"}',
        result: 'Wrote 12 lines',
        isError: false,
      },
    ],
    startedAt: Date.now(),
  });

  const history = memoryService.getConversationHistory(session.id);
  const context = buildConversationContext({
    agentId: 'main',
    history,
    runtimeInfo: { model: 'openai/gpt-5.4', workspacePath: '/workspace/main' },
  });

  const assistant = context.messages.find(
    (message) => message.role === 'assistant',
  );
  expect(assistant?.content).toBe(
    'Sent.\n\n[tool ledger: 2 call(s), 1 failed; message send channel:whatsapp to:+49 151 → error: WhatsApp is not linked; write path:report.md → ok: Wrote 12 lines]',
  );
});
