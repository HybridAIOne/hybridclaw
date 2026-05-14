import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ORIGINAL_GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const ORIGINAL_XAI_API_KEY = process.env.XAI_API_KEY;
const ORIGINAL_BFL_API_KEY = process.env.BFL_API_KEY;
const ORIGINAL_DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
const ORIGINAL_ASSEMBLYAI_API_KEY = process.env.ASSEMBLYAI_API_KEY;

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

afterEach(() => {
  restoreEnvVar('HOME', ORIGINAL_HOME);
  restoreEnvVar('OPENAI_API_KEY', ORIGINAL_OPENAI_API_KEY);
  restoreEnvVar('GOOGLE_API_KEY', ORIGINAL_GOOGLE_API_KEY);
  restoreEnvVar('XAI_API_KEY', ORIGINAL_XAI_API_KEY);
  restoreEnvVar('BFL_API_KEY', ORIGINAL_BFL_API_KEY);
  restoreEnvVar('DEEPGRAM_API_KEY', ORIGINAL_DEEPGRAM_API_KEY);
  restoreEnvVar('ASSEMBLYAI_API_KEY', ORIGINAL_ASSEMBLYAI_API_KEY);
  vi.resetModules();
});

test('resolves provider credentials from the encrypted runtime secret store', async () => {
  process.env.HOME = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-provider-credentials-'),
  );
  process.env.OPENAI_API_KEY = 'env-openai-key';
  process.env.GOOGLE_API_KEY = 'env-google-key';
  process.env.XAI_API_KEY = 'env-xai-key';
  process.env.BFL_API_KEY = 'env-bfl-key';
  process.env.DEEPGRAM_API_KEY = 'env-deepgram-key';
  process.env.ASSEMBLYAI_API_KEY = 'env-assemblyai-key';
  vi.resetModules();

  const { saveNamedRuntimeSecrets } = await import(
    '../src/security/runtime-secrets.js'
  );
  saveNamedRuntimeSecrets({
    OPENAI_API_KEY: 'store-openai-key',
    GOOGLE_API_KEY: 'store-google-key',
    XAI_API_KEY: 'store-xai-key',
    BLACK_FOREST_LABS_API_KEY: 'store-bfl-key',
    OPENAI_AUDIO_MODEL: 'store-openai-audio-model',
    OPENAI_IMAGE_MODEL: 'store-openai-image-model',
    GEMINI_IMAGE_MODEL: 'store-gemini-image-model',
    XAI_IMAGE_MODEL: 'store-xai-image-model',
    BFL_IMAGE_MODEL: 'store-bfl-image-model',
    DEEPGRAM_API_KEY: 'store-deepgram-key',
    DEEPGRAM_AUDIO_MODEL: 'store-deepgram-audio-model',
    ASSEMBLYAI_API_KEY: 'store-assemblyai-key',
    ASSEMBLYAI_AUDIO_MODEL: 'store-assemblyai-audio-model',
  });
  vi.resetModules();

  const { resolveProviderCredentials } = await import(
    '../src/providers/provider-credentials.js'
  );
  const credentials = resolveProviderCredentials();

  expect(credentials.openai?.apiKey).toBe('store-openai-key');
  expect(credentials.gemini?.apiKey).toBe('store-google-key');
  expect(credentials.xai?.apiKey).toBe('store-xai-key');
  expect(credentials.bfl?.apiKey).toBe('store-bfl-key');
  expect(credentials.deepgram?.apiKey).toBe('store-deepgram-key');
  expect(credentials.assemblyai?.apiKey).toBe('store-assemblyai-key');
  expect(credentials.openai?.audioModel).toBe('store-openai-audio-model');
  expect(credentials.openai?.imageModel).toBe('store-openai-image-model');
  expect(credentials.gemini?.imageModel).toBe('store-gemini-image-model');
  expect(credentials.xai?.imageModel).toBe('store-xai-image-model');
  expect(credentials.bfl?.imageModel).toBe('store-bfl-image-model');
  expect(credentials.deepgram?.audioModel).toBe('store-deepgram-audio-model');
  expect(credentials.assemblyai?.audioModel).toBe(
    'store-assemblyai-audio-model',
  );
});

test('ignores provider credentials that only exist in process env', async () => {
  process.env.HOME = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-provider-credentials-empty-'),
  );
  process.env.OPENAI_API_KEY = 'env-openai-key';
  process.env.GOOGLE_API_KEY = 'env-google-key';
  process.env.XAI_API_KEY = 'env-xai-key';
  process.env.BFL_API_KEY = 'env-bfl-key';
  process.env.DEEPGRAM_API_KEY = 'env-deepgram-key';
  process.env.ASSEMBLYAI_API_KEY = 'env-assemblyai-key';
  vi.resetModules();

  const { resolveProviderCredentials } = await import(
    '../src/providers/provider-credentials.js'
  );
  const credentials = resolveProviderCredentials();

  expect(credentials.openai).toBeUndefined();
  expect(credentials.gemini).toBeUndefined();
  expect(credentials.xai).toBeUndefined();
  expect(credentials.bfl).toBeUndefined();
  expect(credentials.deepgram).toBeUndefined();
  expect(credentials.assemblyai).toBeUndefined();
});
