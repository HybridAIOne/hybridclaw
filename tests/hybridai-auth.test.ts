import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import { afterEach, expect, test, vi } from 'vitest';

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_HYBRIDAI_API_KEY = process.env.HYBRIDAI_API_KEY;

function makeTempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-hybridai-auth-'));
}

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  restoreEnvVar('HOME', ORIGINAL_HOME);
  restoreEnvVar('HYBRIDAI_API_KEY', ORIGINAL_HYBRIDAI_API_KEY);
});

test('HybridAI auth resolves the API key from runtime secrets', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  delete process.env.HYBRIDAI_API_KEY;
  vi.resetModules();

  const runtimeSecrets = await import('../src/security/runtime-secrets.ts');
  runtimeSecrets.saveRuntimeSecrets(
    { HYBRIDAI_API_KEY: 'hai-1234567890abcdef' },
    homeDir,
  );

  const hybridAIAuth = await import('../src/auth/hybridai-auth.ts');
  expect(hybridAIAuth.getHybridAIApiKey()).toBe('hai-1234567890abcdef');
  expect(hybridAIAuth.getHybridAIAuthStatus(homeDir)).toEqual({
    authenticated: true,
    path: path.join(homeDir, '.hybridclaw', 'credentials.json'),
    maskedApiKey: 'hai-…cdef',
    source: 'runtime-secrets',
  });
});
