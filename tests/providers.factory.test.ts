import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_HYBRIDAI_API_KEY = process.env.HYBRIDAI_API_KEY;

function makeTempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-providers-'));
}

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

async function importFreshFactory(homeDir: string) {
  process.env.HOME = homeDir;
  vi.resetModules();
  return import('../src/providers/factory.ts');
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  restoreEnvVar('HOME', ORIGINAL_HOME);
  restoreEnvVar('HYBRIDAI_API_KEY', ORIGINAL_HYBRIDAI_API_KEY);
});

test('provider factory resolves adapters by model family', async () => {
  const homeDir = makeTempHome();
  const factory = await importFreshFactory(homeDir);

  expect(factory.resolveModelProvider('gpt-5-nano')).toBe('hybridai');
  expect(factory.resolveModelProvider('openai-codex/gpt-5-codex')).toBe(
    'openai-codex',
  );
  expect(factory.resolveModelProvider('anthropic/claude-3-7-sonnet')).toBe(
    'anthropic',
  );

  expect(factory.modelRequiresChatbotId('gpt-5-nano')).toBe(true);
  expect(factory.modelRequiresChatbotId('openai-codex/gpt-5-codex')).toBe(
    false,
  );
  expect(factory.modelRequiresChatbotId('anthropic/claude-3-7-sonnet')).toBe(
    false,
  );
});

test('provider factory resolves HybridAI runtime credentials', async () => {
  const homeDir = makeTempHome();
  process.env.HYBRIDAI_API_KEY = 'hai-provider-test';
  const factory = await importFreshFactory(homeDir);

  const credentials = await factory.resolveModelRuntimeCredentials({
    model: 'gpt-5-nano',
    chatbotId: 'bot_123',
    enableRag: false,
    agentId: 'main',
  });

  expect(credentials).toMatchObject({
    provider: 'hybridai',
    apiKey: 'hai-provider-test',
    chatbotId: 'bot_123',
    enableRag: false,
    requestHeaders: {},
    agentId: 'main',
  });
});

test('provider factory fails early for unsupported anthropic runtime execution', async () => {
  const homeDir = makeTempHome();
  const factory = await importFreshFactory(homeDir);

  await expect(
    factory.resolveModelRuntimeCredentials({
      model: 'anthropic/claude-3-7-sonnet',
    }),
  ).rejects.toThrow(
    'Anthropic provider is not implemented yet for model "anthropic/claude-3-7-sonnet".',
  );
});
