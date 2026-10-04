import fs from 'node:fs';
import path from 'node:path';

import { expect, test, vi } from 'vitest';

import { isDynamicContextMessageText } from '../container/shared/dynamic-context.js';
import type { ChatMessage } from '../src/types/api.js';
import type {
  ContainerOutput,
  ExecutorRequest,
} from '../src/types/container.js';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

// Providers that cache only at the end of each request (the HybridAI relay,
// OpenAI) reuse history across turns only when every earlier request is a
// prefix of the next one.

const { runAgentMock } = vi.hoisted(() => ({
  runAgentMock: vi.fn(),
}));

vi.mock('../src/agent/agent.js', () => ({
  runAgent: runAgentMock,
}));

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-append-only-prompt-',
  cleanup: () => {
    runAgentMock.mockReset();
  },
});

const REQUEST = {
  sessionId: 'web:append-only-prompt',
  guildId: null,
  channelId: 'web',
  userId: 'user_a',
  username: 'web',
  model: 'openai-codex/gpt-5-codex',
  chatbotId: '',
};

const TOOL_EXCHANGE: ChatMessage[] = [
  {
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id: 'call-1',
        type: 'function',
        function: { name: 'read', arguments: '{"path":"notes.md"}' },
      },
    ],
  },
  { role: 'tool', tool_call_id: 'call-1', content: 'Buy milk.' },
];

async function setupSession(): Promise<void> {
  setupHome();
  const { initDatabase } = await import('../src/memory/db.js');
  const { agentWorkspaceDir } = await import('../src/infra/ipc.js');
  const { ensureBootstrapFiles } = await import('../src/workspace.js');
  initDatabase({ quiet: true });
  // Onboarding wraps each user message for the model only; finish it first.
  ensureBootstrapFiles('main');
  const workspaceDir = agentWorkspaceDir('main');
  fs.unlinkSync(path.join(workspaceDir, 'BOOTSTRAP.md'));
  fs.writeFileSync(
    path.join(workspaceDir, '.hybridclaw', 'workspace-state.json'),
    JSON.stringify({
      version: 1,
      bootstrapSeededAt: '2026-03-28T18:00:00.000Z',
      onboardingCompletedAt: '2026-03-28T18:00:01.000Z',
    }),
  );
}

async function runTurns(outputs: ContainerOutput[]): Promise<ChatMessage[][]> {
  await setupSession();
  const requests: ChatMessage[][] = [];
  for (const output of outputs) {
    runAgentMock.mockImplementationOnce(async (params: ExecutorRequest) => {
      requests.push(structuredClone(params.messages));
      return output;
    });
  }
  const { handleGatewayMessage } = await import(
    '../src/gateway/gateway-chat-service.js'
  );
  for (const [index] of outputs.entries()) {
    await handleGatewayMessage({ ...REQUEST, content: `Message ${index}` });
  }
  return requests;
}

function success(extra: Partial<ContainerOutput> = {}): ContainerOutput {
  return {
    status: 'success',
    result: 'Done.',
    toolsUsed: [],
    toolExecutions: [],
    ...extra,
  };
}

test('each turn sends the previous request unchanged as its prefix', async () => {
  const requests = await runTurns([success(), success(), success()]);

  for (const [index, request] of requests.slice(1).entries()) {
    const previous = requests[index];
    expect(request.slice(0, previous.length)).toEqual(previous);
  }
  const last = requests.at(-1) ?? [];
  expect(
    last.filter(
      (message) =>
        message.role === 'user' && isDynamicContextMessageText(message.content),
    ),
  ).toHaveLength(3);
});

test('a tool turn replays its exchange right after the request that made it', async () => {
  const requests = await runTurns([
    success({
      toolsUsed: ['read'],
      toolHistory: TOOL_EXCHANGE,
      toolHistoryForReplay: TOOL_EXCHANGE,
    }),
    success(),
  ]);

  // The turn's last model call was the first request plus the exchange.
  const lastCallOfFirstTurn = [...requests[0], ...TOOL_EXCHANGE];
  expect(requests[1].slice(0, lastCallOfFirstTurn.length)).toEqual(
    lastCallOfFirstTurn,
  );
});

test('preference edits refresh the new turn while preserving earlier preference snapshots', async () => {
  await setupSession();
  const { agentWorkspaceDir } = await import('../src/infra/ipc.js');
  const { PROACTIVE_PREFERENCES_FILE } = await import(
    '../src/workspace-templates.js'
  );
  const preferencesPath = path.join(
    agentWorkspaceDir('main'),
    PROACTIVE_PREFERENCES_FILE,
  );
  const firstPreferences = '# Preferences\nTell me about project deadlines.\n';
  const secondPreferences = '# Preferences\nTurn proactive messages off.\n';
  fs.writeFileSync(preferencesPath, firstPreferences);
  const requests: ChatMessage[][] = [];
  runAgentMock.mockImplementation(async (params: ExecutorRequest) => {
    requests.push(structuredClone(params.messages));
    return success();
  });
  const { handleGatewayMessage } = await import(
    '../src/gateway/gateway-chat-service.js'
  );
  await handleGatewayMessage({ ...REQUEST, content: 'Hello' });
  fs.writeFileSync(preferencesPath, secondPreferences);
  await handleGatewayMessage({ ...REQUEST, content: 'Hello again' });

  expect(requests[1].slice(0, requests[0].length)).toEqual(requests[0]);
  const latestContext = requests[1]
    .filter((message) => isDynamicContextMessageText(message.content))
    .at(-1);
  expect(latestContext?.content).toContain(secondPreferences);
  expect(latestContext?.content).not.toContain(firstPreferences);
});

test('the stored user message keeps its text and carries the context it was sent with', async () => {
  await runTurns([success(), success()]);
  const { memoryService } = await import('../src/memory/memory-service.js');
  const stored = memoryService.getConversationHistory(REQUEST.sessionId, 10);
  const users = stored.filter((message) => message.role === 'user');
  expect(users).toHaveLength(2);
  for (const user of users) {
    expect(isDynamicContextMessageText(user.dynamic_context)).toBe(true);
    // The UI and search read the message itself, never the context.
    expect(user.content).toMatch(/^Message \d$/);
  }
});

test('a question about a photo keeps the system prompt and tool list', async () => {
  await setupSession();
  const { createUploadedMediaContextItem } = await import(
    '../src/media/uploaded-media-cache.js'
  );
  const photo = await createUploadedMediaContextItem({
    attachmentName: 'photo.png',
    buffer: Buffer.from('89504e470d0a1a0a', 'hex'),
    mimeType: 'image/png',
  });
  const calls: Pick<ExecutorRequest, 'messages' | 'blockedTools'>[] = [];
  runAgentMock.mockImplementation(async (params: ExecutorRequest) => {
    calls.push(
      structuredClone({
        messages: params.messages,
        blockedTools: params.blockedTools,
      }),
    );
    return success();
  });
  const { handleGatewayMessage } = await import(
    '../src/gateway/gateway-chat-service.js'
  );
  await handleGatewayMessage({ ...REQUEST, content: 'Plain question' });
  await handleGatewayMessage({
    ...REQUEST,
    content: 'What is on this photo?',
    media: [photo],
  });

  const system = (call: (typeof calls)[number]) =>
    call.messages.filter((message) => message.role === 'system');
  expect(system(calls[1])).toEqual(system(calls[0]));
  expect(calls[1].blockedTools).toEqual(calls[0].blockedTools);
  expect(calls[1].blockedTools ?? []).not.toContain('browser_vision');
});
