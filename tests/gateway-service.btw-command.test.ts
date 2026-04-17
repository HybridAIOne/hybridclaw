import { expect, test, vi } from 'vitest';

import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-gateway-btw-',
});

test('btw command answers side question using a tool-less model call', async () => {
  setupHome();

  const callAuxiliaryModelMock = vi.fn(async () => ({
    provider: 'hybridai' as const,
    model: 'hybridai/gpt-5-nano',
    content: 'We are editing src/foo.ts.',
  }));
  vi.doMock('../src/providers/auxiliary.js', () => ({
    callAuxiliaryModel: callAuxiliaryModelMock,
  }));

  const { initDatabase } = await import('../src/memory/db.ts');
  const { memoryService } = await import('../src/memory/memory-service.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });

  const session = memoryService.getOrCreateSession(
    'session-btw',
    null,
    'web',
    undefined,
  );
  memoryService.storeMessage({
    sessionId: session.id,
    userId: 'test-user',
    username: 'tester',
    role: 'user',
    content: 'Please refactor src/foo.ts into smaller modules.',
  });
  memoryService.storeMessage({
    sessionId: session.id,
    userId: 'test-user',
    username: 'tester',
    role: 'assistant',
    content: 'Working on the refactor now.',
  });

  const result = await handleGatewayCommand({
    sessionId: session.id,
    guildId: null,
    channelId: 'web',
    args: ['btw', 'what', 'file', 'are', 'we', 'editing?'],
  });

  expect(result.kind).toBe('info');
  if (result.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${result.kind}`);
  }
  expect(result.title).toBe('BTW');
  expect(result.text).toContain('src/foo.ts');

  expect(callAuxiliaryModelMock).toHaveBeenCalledTimes(1);
  const call = callAuxiliaryModelMock.mock.calls[0]?.[0];
  expect(call).toBeDefined();
  expect(call?.tools).toEqual([]);
  const systemMessage = call?.messages?.find((m) => m.role === 'system');
  expect(typeof systemMessage?.content === 'string').toBe(true);
  expect(String(systemMessage?.content)).toContain(
    'ephemeral /btw side question',
  );
  const lastUserMessage = call?.messages
    ?.filter((m) => m.role === 'user')
    .pop();
  expect(String(lastUserMessage?.content)).toContain(
    'what file are we editing?',
  );
  expect(
    call?.messages?.some((m) => m.content === 'Working on the refactor now.'),
  ).toBe(true);

  // BTW must not persist to session history.
  const messagesAfter = memoryService.getRecentMessages(session.id);
  expect(messagesAfter.length).toBe(2);
});

test('btw command without a question returns a usage error', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });

  const result = await handleGatewayCommand({
    sessionId: 'session-btw-empty',
    guildId: null,
    channelId: 'web',
    args: ['btw'],
  });

  expect(result.kind).toBe('error');
  expect(result.text).toContain('Usage');
});

test('btw command surfaces auxiliary model failures as errors', async () => {
  setupHome();

  const callAuxiliaryModelMock = vi.fn(async () => {
    throw new Error('provider unavailable');
  });
  vi.doMock('../src/providers/auxiliary.js', () => ({
    callAuxiliaryModel: callAuxiliaryModelMock,
  }));

  const { initDatabase } = await import('../src/memory/db.ts');
  const { memoryService } = await import('../src/memory/memory-service.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });

  const session = memoryService.getOrCreateSession(
    'session-btw-err',
    null,
    'web',
    undefined,
  );
  memoryService.storeMessage({
    sessionId: session.id,
    userId: 'test-user',
    username: 'tester',
    role: 'user',
    content: 'Something earlier.',
  });

  const result = await handleGatewayCommand({
    sessionId: session.id,
    guildId: null,
    channelId: 'web',
    args: ['btw', 'what', 'happened?'],
  });

  expect(result.kind).toBe('error');
  expect(result.text).toContain('provider unavailable');
});
