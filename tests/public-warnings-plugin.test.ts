import { expect, test, vi } from 'vitest';
import type {
  HybridClawPluginApi,
  PluginService,
  PluginToolDefinition,
} from '../src/plugins/plugin-types.js';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-public-warnings-',
});

const CELLS = [
  '﻿WARNCELLID;NAME;KURZNAME;CCC;BL',
  '109162000;Stadt München;St. München;MXX;BY',
  '109184000;Kreis München;Kr. München;;BY',
  '809162000;Stadt München;München;;BY',
  '106534000;Kreis Marburg-Biedenkopf;Marburg-Biedenk.;;HE',
  '806534016;Stadt Neustadt (Hessen);Neustadt/He;;HE',
  '107316000;Stadt Neustadt an der Weinstraße;Neustadt a.d.W.;;RP',
  '807316000;Stadt Neustadt an der Weinstraße;Neustadt/Weins.;;RP',
].join('\r\n');

function entry(id: string, provider: string, severity: string) {
  return {
    id,
    payload: { data: { headline: `Warnung ${id}`, provider, severity, valid: true } },
    sent: '2026-10-15T08:00:00+02:00',
  };
}

const OLD = entry('mow.TEST-OLD', 'MOWAS', 'Minor');
const NEW = entry('mow.TEST-NEW', 'MOWAS', 'Minor');
const YELLOW = entry('dwdmap.TEST-FROST', 'DWD', 'Minor');

async function load() {
  const home = setupHome();
  let dashboard = [OLD];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.includes('cap_warncellids')) return new Response(CELLS);
      if (url.endsWith('/dashboard/091620000000.json'))
        return Response.json(dashboard);
      if (url.includes('/api31/warnings/'))
        return Response.json({
          info: [
            { language: 'de', headline: 'Bombenentschärfung', instruction: 'Bereich meiden.' },
            {
              language: 'en',
              headline: 'Bomb disposal',
              instruction: 'Avoid the area.<br/><b>Close</b> windows.<<script>x</script>',
              onset: '2026-10-15T10:00:00+02:00',
              expires: '2026-10-15T14:00:00+02:00',
            },
          ],
        });
      return new Response('not found', { status: 404 });
    }),
  );
  let tool: PluginToolDefinition | undefined;
  let service: PluginService | undefined;
  const postToMainChat = vi.fn(() => true);
  const api = {
    runtime: { homeDir: home },
    logger: { info: vi.fn(), warn: vi.fn() },
    resolveSessionAgentId: () => 'hy',
    registerTool: (value: PluginToolDefinition) => { tool = value; },
    registerService: (value: PluginService) => { service = value; },
    postToMainChat,
  } as unknown as HybridClawPluginApi;
  (await import('../plugins/public-warnings/src/index.js')).default.register(api);
  const call = async (args: Record<string, unknown>) =>
    JSON.parse(String(await tool!.handler(args, { sessionId: 'main-chat' } as never)));
  const poll = async () => {
    await service!.start!();
    await service!.stop!();
  };
  return { call, poll, postToMainChat, setDashboard: (value: unknown[]) => { dashboard = value as never; } };
}

test('a watched place gets each new warning once, in the user language; yellow weather stays quiet', async () => {
  const { call, poll, postToMainChat, setDashboard } = await load();

  const watched = await call({ action: 'watch', place: 'München', label: 'Home', language: 'en' });
  expect(watched).toMatchObject({ watching: 'Home', district: '09162' });
  expect(watched.warnings.map((warning: { id: string }) => warning.id)).toEqual([OLD.id]);
  await poll();
  expect(postToMainChat).not.toHaveBeenCalled();

  setDashboard([OLD, NEW, YELLOW]);
  await poll();
  await poll();
  expect(postToMainChat).toHaveBeenCalledTimes(1);
  expect(postToMainChat).toHaveBeenCalledWith(
    'hy',
    [
      '⚠️ Home: Bomb disposal',
      '15.10., 10:00 → 15.10., 14:00',
      'Avoid the area.\nClose windows.x',
      'https://warnung.bund.de/meldungen/mow.TEST-NEW',
    ].join('\n\n'),
    NEW.id,
  );
  expect(await call({ action: 'list' })).toEqual({
    places: [{ district: '09162', label: 'Home', language: 'en' }],
  });
});

test('ambiguous names list their districts and places outside Germany are refused', async () => {
  const { call } = await load();

  const neustadt = await call({ action: 'check', place: 'Neustadt' });
  expect(neustadt.candidates.map((place: { district: string }) => place.district)).toEqual(['06534', '07316']);
  await expect(call({ action: 'check', place: 'Paris' })).rejects.toThrow(/Only places in Germany/);
});

test('postToMainChat stores the message in the agent main chat', async () => {
  setupHome();
  const { initDatabase, getRecentMessages } = await import('../src/memory/db.ts');
  const { memoryService } = await import('../src/memory/memory-service.ts');
  const { createPluginApi } = await import('../src/plugins/plugin-api.ts');
  initDatabase({ quiet: true });
  memoryService.getOrCreateSession('main-abc-hy', null, 'web', 'hy');
  const api = createPluginApi({
    manager: {} as never,
    pluginId: 'public-warnings',
    pluginDir: '/plugin',
    registrationMode: 'full',
    config: { agents: {} } as never,
    pluginConfig: {},
    declaredEnv: [],
    homeDir: '/home',
    cwd: '/',
  });

  expect(api.postToMainChat('hy', 'Storm warning', 'w-1')).toBe(true);
  expect(api.postToMainChat('main', 'Storm warning', 'w-1')).toBe(false);
  const session = memoryService.getSessionById('main-abc-hy');
  expect(getRecentMessages(session!.id, 5)).toEqual([
    expect.objectContaining({ role: 'assistant', content: 'Storm warning', source: 'public-warnings:w-1' }),
  ]);
});
