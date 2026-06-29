import { expect, test, vi } from 'vitest';

import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-gateway-aux-',
});

async function loadGatewayFixture() {
  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });
  return { handleGatewayCommand };
}

test('aux command triggers a configured auxiliary text task', async () => {
  setupHome();

  const callAuxiliaryModelMock = vi.fn(async () => ({
    provider: 'vllm' as const,
    model: 'haigpu2/google/gemma-4-e4b-it',
    content: 'pong from aux',
    usage: {
      inputTokens: 12,
      outputTokens: 3,
      totalTokens: 15,
    },
  }));
  vi.doMock('../src/providers/auxiliary.js', () => ({
    callAuxiliaryModel: callAuxiliaryModelMock,
  }));

  const { handleGatewayCommand } = await loadGatewayFixture();
  const result = await handleGatewayCommand({
    sessionId: 'session-aux-command',
    guildId: null,
    channelId: 'web',
    args: [
      'aux',
      'test',
      'compression',
      'Say',
      'pong',
      '--max-tokens',
      '64',
    ],
  });

  expect(result.kind).toBe('info');
  if (result.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${result.kind}`);
  }
  expect(result.title).toBe('Auxiliary Model');
  expect(result.text).toContain('Task: compression');
  expect(result.text).toContain('Provider: vllm');
  expect(result.text).toContain('Model: haigpu2/google/gemma-4-e4b-it');
  expect(result.text).toContain('Usage: 12 input / 3 output / 15 total');
  expect(result.text).toContain('pong from aux');

  expect(callAuxiliaryModelMock).toHaveBeenCalledTimes(1);
  const call = callAuxiliaryModelMock.mock.calls[0]?.[0];
  expect(call).toMatchObject({
    task: 'compression',
    tools: [],
    maxTokens: 64,
    timeoutMs: 300_000,
  });
  expect(call?.messages).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        role: 'system',
        content: expect.stringContaining('auxiliary model smoke test'),
      }),
      expect.objectContaining({
        role: 'user',
        content: expect.stringContaining('Say pong'),
      }),
    ]),
  );
});

test('aux command rejects vision task smoke tests', async () => {
  setupHome();

  const { handleGatewayCommand } = await loadGatewayFixture();
  const result = await handleGatewayCommand({
    sessionId: 'session-aux-vision',
    guildId: null,
    channelId: 'web',
    args: ['aux', 'test', 'vision', 'Describe this image'],
  });

  expect(result.kind).toBe('error');
  expect(result.title).toBe('Usage');
  expect(result.text).toContain('vision');
});
