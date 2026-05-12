import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ORIGINAL_GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const ORIGINAL_XAI_API_KEY = process.env.XAI_API_KEY;
const ORIGINAL_BFL_API_KEY = process.env.BFL_API_KEY;

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
  vi.resetModules();
});

test('resolves provider credentials in the gateway layer', async () => {
  process.env.HOME = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-provider-credentials-'),
  );
  process.env.OPENAI_API_KEY = 'openai-test-key';
  process.env.GOOGLE_API_KEY = 'google-test-key';
  process.env.XAI_API_KEY = 'xai-test-key';
  process.env.BFL_API_KEY = 'bfl-test-key';
  vi.resetModules();

  const { resolveProviderCredentials } = await import(
    '../src/providers/provider-credentials.js'
  );
  const credentials = resolveProviderCredentials();

  expect(credentials.openai?.apiKey).toBe('openai-test-key');
  expect(credentials.gemini?.apiKey).toBe('google-test-key');
  expect(credentials.xai?.apiKey).toBe('xai-test-key');
  expect(credentials.bfl?.apiKey).toBe('bfl-test-key');
});
