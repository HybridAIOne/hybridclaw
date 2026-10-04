import { expect, test, vi } from 'vitest';
import { runPreferencesTool } from '../container/src/tools/preferences.ts';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { setupHome } = setupGatewayTest({ tempHomePrefix: 'hy-preferences-command-' });

test('mobile feedback is dispatched as a command and foreground context reads it', async () => {
  setupHome();
  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayCommand } = await import('../src/gateway/gateway-service.ts');
  const { resolveTextChannelSlashCommands } = await import('../src/gateway/text-channel-commands.ts');
  const { buildConversationContext } = await import('../src/agent/conversation.ts');
  initDatabase({ quiet: true });
  const token = Buffer.from(JSON.stringify([{ id: 'phone', key: 'coverage', kind: 'instruction', text: 'Less crypto, more cycling', at: 1 }])).toString('base64url');
  const parsed = resolveTextChannelSlashCommands(`/preferences sync ${token} --json`);
  expect(parsed).not.toBeNull();
  const result = await handleGatewayCommand({ sessionId: 'mobile-feedback', guildId: null, channelId: 'web', userId: 'alice', args: parsed![0] });
  expect(result.kind).toBe('plain');
  expect(JSON.parse(result.text)).toEqual({ version: 1, acknowledged: ['phone'] });
  const context = (userId: string) => buildConversationContext({
    agentId: 'main', history: [], runtimeInfo: {
      sessionContext: { agentId: 'main', sessionId: 'another-chat', source: { chatId: 'web', chatType: 'dm', userId } },
    },
  });
  expect(JSON.stringify(context('alice').messages)).toContain('Less crypto, more cycling');
  expect(JSON.stringify(context('bob').messages)).not.toContain('Less crypto, more cycling');
});

test('the preference tool pins its session and reports transport failure', async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: 'Preference saved.' })));
  vi.stubGlobal('fetch', fetch);
  const gateway = { baseUrl: 'https://example.com', apiToken: 'test-key', sessionId: 'current' };
  expect((await runPreferencesTool({ action: 'get', sessionId: 'victim' }, gateway)).ok).toBe(true);
  const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe('https://example.com/api/preferences');
  expect(JSON.parse(String(init.body)).sessionId).toBe('current');
  fetch.mockImplementation(async () => new Response('unavailable', { status: 503 }));
  expect((await runPreferencesTool({ action: 'get' }, gateway)).ok).toBe(false);
});
