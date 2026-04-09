import fs from 'node:fs';
import path from 'node:path';

import { expect, test, vi } from 'vitest';

vi.mock('../src/security/runtime-secrets.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../src/security/runtime-secrets.js')>();
  return {
    ...actual,
    readStoredRuntimeSecret: vi.fn((key: string) =>
      key === 'HYBRIDAI_API_KEY' ? 'hai-stored-secret' : null,
    ),
  };
});

function makePluginManagerStub() {
  return {
    registerMemoryLayer() {},
    registerProvider() {},
    registerChannel() {},
    registerTool() {},
    registerPromptHook() {},
    registerCommand() {},
    registerService() {},
    registerInboundWebhook() {},
    dispatchInboundMessage() {
      return Promise.resolve({
        status: 'success' as const,
        result: 'ok',
        toolsUsed: [],
      });
    },
    registerHook() {},
  };
}

test('createPluginApi reads declared credentials from stored runtime secrets', async () => {
  const { createPluginApi } = await import('../src/plugins/plugin-api.js');
  const config = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'config.example.json'), 'utf-8'),
  );

  const original = process.env.HYBRIDAI_API_KEY;
  delete process.env.HYBRIDAI_API_KEY;

  try {
    const api = createPluginApi({
      manager: makePluginManagerStub() as never,
      pluginId: 'demo-plugin',
      pluginDir: '/tmp/demo-plugin',
      registrationMode: 'full',
      config,
      pluginConfig: {},
      declaredEnv: ['HYBRIDAI_API_KEY'],
      homeDir: '/tmp/home',
      cwd: '/tmp/project',
    });

    expect(api.getCredential('HYBRIDAI_API_KEY')).toBe('hai-stored-secret');
  } finally {
    if (original === undefined) {
      delete process.env.HYBRIDAI_API_KEY;
    } else {
      process.env.HYBRIDAI_API_KEY = original;
    }
  }
});

test('createPluginApi reads optional declared credentials from stored runtime secrets', async () => {
  const { createPluginApi } = await import('../src/plugins/plugin-api.js');
  const config = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'config.example.json'), 'utf-8'),
  );

  const original = process.env.HYBRIDAI_API_KEY;
  delete process.env.HYBRIDAI_API_KEY;

  try {
    const api = createPluginApi({
      manager: makePluginManagerStub() as never,
      pluginId: 'demo-plugin',
      pluginDir: '/tmp/demo-plugin',
      registrationMode: 'full',
      config,
      pluginConfig: {},
      declaredEnv: [],
      declaredCredentials: ['HYBRIDAI_API_KEY'],
      homeDir: '/tmp/home',
      cwd: '/tmp/project',
    });

    expect(api.getCredential('HYBRIDAI_API_KEY')).toBe('hai-stored-secret');
  } finally {
    if (original === undefined) {
      delete process.env.HYBRIDAI_API_KEY;
    } else {
      process.env.HYBRIDAI_API_KEY = original;
    }
  }
});
