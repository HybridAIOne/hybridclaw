import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

import type { RuntimeConfig } from '../src/config/runtime-config.js';

const tempDirs: string[] = [];
const originalApiKey = process.env.HYBRIDAI_API_KEY;

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function loadRuntimeConfig(): RuntimeConfig {
  return JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'config.example.json'), 'utf-8'),
  ) as RuntimeConfig;
}

function installBundledPlugin(cwd: string): string {
  const sourceDir = path.join(process.cwd(), 'plugins', 'hybridai-knowledge');
  const targetDir = path.join(cwd, '.hybridclaw', 'plugins', 'hybridai-knowledge');
  fs.mkdirSync(path.dirname(targetDir), { recursive: true });
  fs.cpSync(sourceDir, targetDir, { recursive: true });
  return targetDir;
}

function toolResult(payload: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [{ type: 'text', text: JSON.stringify(payload) }],
        isError: false,
      },
    }),
  };
}

async function loadManager(config: RuntimeConfig, homeDir: string, cwd: string) {
  const { PluginManager } = await import('../src/plugins/plugin-manager.js');
  const manager = new PluginManager({
    homeDir,
    cwd,
    getRuntimeConfig: () => config,
  });
  await manager.ensureInitialized();
  return manager;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  if (originalApiKey === undefined) delete process.env.HYBRIDAI_API_KEY;
  else process.env.HYBRIDAI_API_KEY = originalApiKey;
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('hybridai-knowledge injects the best sections, tagged by collection and anchor', async () => {
  const homeDir = makeTempDir('hybridclaw-knowledge-home-');
  const cwd = makeTempDir('hybridclaw-knowledge-project-');
  installBundledPlugin(cwd);
  process.env.HYBRIDAI_API_KEY = 'hai-test-key';

  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    expect(body.method).toBe('tools/call');
    expect(body.params.name).toBe('knowledge_search');
    return toolResult({
      status: 'success',
      results: [
        {
          collection: 'Handbook_1',
          path: 'raw/pricelist.md',
          location: 'raw/pricelist.md#tiers',
          heading: 'Pricelist > Tiers',
          title: 'Pricelist',
          type: 'raw',
          score: 0.41,
          content: 'Enterprise starts at 20 seats.',
        },
        {
          collection: 'Handbook_1',
          path: 'concepts/pricing.md',
          location: 'concepts/pricing.md#discounts',
          heading: 'Pricing > Discounts',
          title: 'Pricing',
          type: 'concept',
          score: 0.83,
          content: 'Non-profits get twenty percent off.',
        },
        {
          collection: 'Handbook_1',
          path: 'concepts/old.md',
          location: 'concepts/old.md',
          heading: '',
          title: 'Old',
          type: 'concept',
          score: 0.05,
          content: 'Too weak to inject.',
        },
      ],
    });
  });
  vi.stubGlobal('fetch', fetchMock);

  const config = loadRuntimeConfig();
  config.hybridai.baseUrl = 'https://platform.example';
  config.plugins.list = [
    {
      id: 'hybridai-knowledge',
      enabled: true,
      config: { collections: ['Handbook_1'], limit: 3, maxInjectedChars: 2000 },
    },
  ];
  const manager = await loadManager(config, homeDir, cwd);

  const sections = await manager.collectPromptContext({
    sessionId: 'session-1',
    userId: 'user-1',
    agentId: 'main',
    channelId: 'web',
    recentMessages: [
      {
        id: 1,
        session_id: 'session-1',
        user_id: 'user-1',
        username: 'ada',
        role: 'assistant',
        content: 'How can I help?',
        created_at: '2026-10-25T08:00:00.000Z',
      },
      {
        id: 2,
        session_id: 'session-1',
        user_id: 'user-1',
        username: 'ada',
        role: 'user',
        content: 'What discount do non-profits get?',
        created_at: '2026-10-25T08:00:05.000Z',
      },
    ],
  });

  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  expect(url).toBe('https://platform.example/api/v1/connectors/mcp');
  expect(new Headers(init.headers).get('authorization')).toBe('Bearer hai-test-key');
  expect(JSON.parse(String(init.body)).params.arguments).toEqual({
    query: 'What discount do non-profits get?',
    limit: 3,
    collection: 'Handbook_1',
  });

  const section = sections.find((text) => text.includes('[knowledge:'));
  expect(section).toBeDefined();
  const curated = section!.indexOf('[knowledge: Handbook_1/concepts/pricing.md#discounts]');
  const raw = section!.indexOf('[knowledge: Handbook_1/raw/pricelist.md#tiers]');
  expect(curated).toBeGreaterThan(-1);
  expect(raw).toBeGreaterThan(curated);
  expect(section).toContain('Non-profits get twenty percent off.');
  expect(section).not.toContain('Too weak to inject.');
});

test('hybridai-knowledge stays silent when the gateway fails or the key is missing', async () => {
  const homeDir = makeTempDir('hybridclaw-knowledge-home-');
  const cwd = makeTempDir('hybridclaw-knowledge-project-');
  installBundledPlugin(cwd);
  process.env.HYBRIDAI_API_KEY = 'hai-test-key';
  const fetchMock = vi.fn(async () => {
    throw new Error('connection refused');
  });
  vi.stubGlobal('fetch', fetchMock);

  const config = loadRuntimeConfig();
  config.plugins.list = [{ id: 'hybridai-knowledge', enabled: true, config: {} }];
  const manager = await loadManager(config, homeDir, cwd);
  const recentMessages = [
    {
      id: 1,
      session_id: 'session-1',
      user_id: 'user-1',
      username: 'ada',
      role: 'user' as const,
      content: 'Anything about pricing?',
      created_at: '2026-10-25T08:00:00.000Z',
    },
  ];
  const withFailure = await manager.collectPromptContext({
    sessionId: 'session-1',
    userId: 'user-1',
    agentId: 'main',
    channelId: 'web',
    recentMessages,
  });
  expect(withFailure.some((text) => text.includes('[knowledge:'))).toBe(false);
  expect(fetchMock).toHaveBeenCalledTimes(1);

  delete process.env.HYBRIDAI_API_KEY;
  vi.resetModules();
  const withoutKey = await loadManager(config, homeDir, cwd);
  const silent = await withoutKey.collectPromptContext({
    sessionId: 'session-2',
    userId: 'user-1',
    agentId: 'main',
    channelId: 'web',
    recentMessages,
  });
  expect(silent.some((text) => text.includes('[knowledge:'))).toBe(false);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
