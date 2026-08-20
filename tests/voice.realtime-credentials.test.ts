import { afterEach, expect, test, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('../src/config/config.js');
  vi.doUnmock('../src/auth/hybridai-auth.js');
  vi.resetModules();
});

async function loadCredentials(params: {
  openaiKey?: string;
  hybridaiKey?: string | null;
  readHybridAI?: () => string | null;
  baseUrl?: string;
}) {
  vi.doMock('../src/config/config.js', () => ({
    OPENAI_API_KEY: params.openaiKey ?? '',
    HYBRIDAI_BASE_URL: params.baseUrl ?? 'https://hybridai.one',
  }));
  vi.doMock('../src/auth/hybridai-auth.js', () => ({
    readHybridAIApiKey:
      params.readHybridAI ?? (() => params.hybridaiKey ?? null),
  }));
  return import('../src/channels/voice/realtime-credentials.js');
}

test('openai provider connects to api.openai.com with OPENAI_API_KEY', async () => {
  const credentials = await loadCredentials({
    openaiKey: 'sk-test',
    readHybridAI: () => {
      throw new Error('HybridAI auth should not be read');
    },
  });

  const resolved = credentials.resolveRealtimeConnection('openai');

  expect(resolved.connection).toEqual({
    url: 'wss://api.openai.com/v1/realtime',
    apiKey: 'sk-test',
  });
  expect(credentials.isRealtimeCredentialConfigured('openai')).toBe(true);
});

test('openai provider without a key explains the missing credential', async () => {
  const credentials = await loadCredentials({ openaiKey: '' });

  const resolved = credentials.resolveRealtimeConnection('openai');

  expect(resolved.connection).toBeNull();
  expect(resolved.error).toContain('OPENAI_API_KEY');
  expect(credentials.isRealtimeCredentialConfigured('openai')).toBe(false);
});

test('hybridai provider derives a wss URL from HYBRIDAI_BASE_URL', async () => {
  const credentials = await loadCredentials({
    hybridaiKey: 'hai-key',
    baseUrl: 'https://hybridai.one/',
  });

  const resolved = credentials.resolveRealtimeConnection('hybridai');

  expect(resolved.connection).toEqual({
    url: 'wss://hybridai.one/v1/realtime',
    apiKey: 'hai-key',
  });
});

test('hybridai provider keeps plain ws for http dev base URLs', async () => {
  const credentials = await loadCredentials({
    hybridaiKey: 'hai-key',
    baseUrl: 'http://127.0.0.1:5000',
  });

  const resolved = credentials.resolveRealtimeConnection('hybridai');

  expect(resolved.connection?.url).toBe('ws://127.0.0.1:5000/v1/realtime');
});

test('hybridai provider without a signed-in key explains itself', async () => {
  const credentials = await loadCredentials({
    hybridaiKey: null,
    openaiKey: 'sk-unrelated',
  });

  const resolved = credentials.resolveRealtimeConnection('hybridai');

  expect(resolved.connection).toBeNull();
  expect(resolved.error).toContain('HybridAI API key');
  expect(credentials.isRealtimeCredentialConfigured('hybridai')).toBe(false);
});

test('auto prefers hybridai when a HybridAI credential is present', async () => {
  const credentials = await loadCredentials({
    hybridaiKey: 'hai-key',
    openaiKey: 'sk-unused',
  });

  const resolved = credentials.resolveRealtimeConnection('auto');

  expect(resolved.connection).toEqual({
    url: 'wss://hybridai.one/v1/realtime',
    apiKey: 'hai-key',
  });
  expect(credentials.isRealtimeCredentialConfigured('auto')).toBe(true);
});

test('auto falls back to openai when only OPENAI_API_KEY is set', async () => {
  const credentials = await loadCredentials({
    hybridaiKey: null,
    openaiKey: 'sk-test',
  });

  const resolved = credentials.resolveRealtimeConnection('auto');

  expect(resolved.connection).toEqual({
    url: 'wss://api.openai.com/v1/realtime',
    apiKey: 'sk-test',
  });
});

test('auto without any credential names both options', async () => {
  const credentials = await loadCredentials({ hybridaiKey: null });

  const resolved = credentials.resolveRealtimeConnection('auto');

  expect(resolved.connection).toBeNull();
  expect(resolved.error).toContain('HYBRIDAI_API_KEY');
  expect(resolved.error).toContain('OPENAI_API_KEY');
  expect(credentials.isRealtimeCredentialConfigured('auto')).toBe(false);
});
