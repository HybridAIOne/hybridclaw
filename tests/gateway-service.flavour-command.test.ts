import { expect, test, vi } from 'vitest';

import { setupGatewayTest } from './helpers/gateway-test-setup.js';

// What HybridAI's /v1/models offers; no network in tests.
const offered = vi.hoisted(() => ({ models: [] as string[] }));
vi.mock('../src/providers/hybridai-discovery.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getDiscoveredHybridAIModelNames: () => offered.models,
}));
vi.mock('../src/providers/model-catalog.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  refreshAvailableModelCatalogs: async () => ({}),
}));

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-gateway-flavour-command-',
});

async function load() {
  setupHome();
  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );
  const { resolveTextChannelSlashCommands } = await import(
    '../src/gateway/text-channel-commands.ts'
  );
  const { getOrCreateSession, updateSessionModel } = await import(
    '../src/memory/sessions.ts'
  );
  const { resolveAgentForRequest } = await import(
    '../src/agents/agent-registry.ts'
  );
  initDatabase({ quiet: true });

  const sessionId = 'app-flavour';
  const session = () => getOrCreateSession(sessionId, null, 'web');
  // As a web chat turn arrives: parsed from the text, then dispatched.
  const send = async (text: string) => {
    const parsed = resolveTextChannelSlashCommands(text);
    expect(parsed).not.toBeNull();
    const result = await handleGatewayCommand({
      sessionId,
      guildId: null,
      channelId: 'web',
      args: parsed?.[0] ?? [],
      userId: 'user_a',
    });
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(result.text);
    } catch {}
    return { kind: result.kind, text: result.text, json };
  };
  // The model a chat turn or scheduled task of the agent would use.
  const effectiveModel = () => resolveAgentForRequest({ session: session() }).model;
  return { send, session, effectiveModel, updateSessionModel, sessionId };
}

test('an app switches the agent between model flavours', async () => {
  const { send, effectiveModel, updateSessionModel, sessionId, session } =
    await load();
  offered.models = [
    'hybridai/gpt-6-luna',
    'hybridai/anthropic/claude-haiku-5-5',
    'hybridai/melious/glm-5.3-flash',
  ];

  expect((await send('/flavour --json')).json).toEqual({
    version: 1,
    flavour: 'openai',
    model: 'gpt-6-luna',
    available: ['openai', 'anthropic', 'eu'],
  });

  // A model pinned in this chat would win over the agent's; setting a flavour
  // clears it so the chat follows right away.
  session();
  updateSessionModel(sessionId, 'hybridai/gpt-5.6-sol');
  expect((await send('/flavour set eu --json')).json).toMatchObject({
    flavour: 'eu',
    model: 'hybridai/melious/glm-5.3-flash',
  });
  expect(effectiveModel()).toBe('hybridai/melious/glm-5.3-flash');

  await send('/flavour set Anthropic --json');
  expect(effectiveModel()).toBe('hybridai/anthropic/claude-haiku-5-5');
});

test('a flavour HybridAI does not offer yet is refused and the agent stays', async () => {
  const { send, effectiveModel } = await load();
  offered.models = ['hybridai/gpt-6-luna', 'hybridai/anthropic/claude-haiku-5-5'];

  expect((await send('/flavour --json')).json).toMatchObject({
    available: ['openai', 'anthropic'],
  });
  const refused = await send('/flavour set eu --json');
  expect(refused.kind).toBe('error');
  expect(effectiveModel()).toBe('gpt-6-luna');

  expect((await send('/flavour set mistral')).kind).toBe('error');
});
