import { Readable } from 'node:stream';
import { expect, test, vi } from 'vitest';
import type {
  HybridClawPluginApi,
  PluginAdminRouteDefinition,
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
              instruction: 'Avoid the area.<br/><b>Close</b> windows.<<script>x</script> below < 0 °C',
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
  const routes = new Map<string, PluginAdminRouteDefinition>();
  const postToMainChat = vi.fn(() => true);
  const api = {
    runtime: { homeDir: home },
    logger: { info: vi.fn(), warn: vi.fn() },
    resolveSessionAgentId: () => 'hy',
    registerTool: (value: PluginToolDefinition) => { tool = value; },
    registerAdminRoute: (route: PluginAdminRouteDefinition) => { routes.set(route.method, route); },
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
  return { call, poll, routes, postToMainChat, setDashboard: (value: unknown[]) => { dashboard = value as never; } };
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
      'Avoid the area.\nClose windows.<x below < 0 °C',
      'https://warnung.bund.de/meldungen/mow.TEST-NEW',
    ].join('\n\n'),
    NEW.id,
  );
  expect(await call({ action: 'list' })).toEqual({
    enabled: true,
    maxPlaces: 10,
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

test('pausing keeps districts saved and resuming delivers active warnings', async () => {
  const { call, poll, postToMainChat, setDashboard } = await load();
  expect(await call({ action: 'list' })).toEqual({ enabled: false, places: [], maxPlaces: 10 });
  await call({ action: 'watch', district: '09162' });
  const paused = await call({ action: 'pause' });
  expect(paused).toMatchObject({ enabled: false, places: [{ district: '09162' }] });
  setDashboard([NEW]);
  await poll();
  expect(postToMainChat).not.toHaveBeenCalled();
  expect(await call({ action: 'resume' })).toEqual({ ...paused, enabled: true });
  await poll();
  expect(postToMainChat).toHaveBeenCalledOnce();
  await call({ action: 'unwatch', district: '09162' });
  expect(await call({ action: 'list' })).toEqual({ enabled: false, places: [], maxPlaces: 10 });
});

test('mobile settings share chat watches and can remove a paused district without contacting NINA', async () => {
  const { routes, call } = await load();
  const { upsertRegisteredAgent } = await import('../src/agents/agent-registry.js');
  const { initDatabase } = await import('../src/memory/db.js');
  initDatabase({ quiet: true });
  upsertRegisteredAgent({ id: 'hy' });
  const read = routes.get('GET')!;
  const write = routes.get('POST')!;
  expect(read.path).toBe('/api/admin/public-warnings/settings');
  expect(write.path).toBe(read.path);
  expect([read.rbacAction, write.rbacAction]).toEqual(['data_controls.read', 'data_controls.write']);
  const request = async (query: string, body?: Record<string, string>) => {
    const route = body ? write : read;
    const end = vi.fn();
    await route.handler({
      req: Readable.from(body ? [JSON.stringify(body)] : []) as never,
      res: { setHeader: vi.fn(), end } as never,
      url: new URL(read.path + '?' + query, 'https://example.test'),
      params: {},
    });
    return JSON.parse(end.mock.calls[0][0]);
  };
  const owner = 'agentId=hy';
  expect((await request(owner + '&place=Neustadt')).candidates).toHaveLength(2);
  await expect(request('agentId=unknown')).rejects.toThrow('Unknown agent');
  await expect(request(owner, { action: 'watch' })).rejects.toThrow('Invalid district');
  const mainSession = 'main-' + 'a'.repeat(32) + '-hy';
  const saved = await request(owner, { action: 'watch', district: '09162', label: 'Home', language: 'en', mainSession });
  const { getAgentMainSession } = await import('../src/memory/agent-main-session.js');
  expect(getAgentMainSession('hy')?.session_key).toBe(mainSession);
  upsertRegisteredAgent({ id: 'other' });
  await expect(request('agentId=other', { action: 'watch', district: '09162', mainSession })).rejects.toThrow('another agent');
  expect(saved.enabled).toBe(true);
  expect(await call({ action: 'list' })).toEqual(saved);
  await call({ action: 'pause' });
  expect(await request(owner)).toEqual({ ...saved, enabled: false });
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));
  expect(await request(owner, { action: 'unwatch', district: '09162' })).toEqual({
    enabled: false, places: [], maxPlaces: 10,
  });
  expect(fetch).not.toHaveBeenCalled();
});

test('pausing while the watcher fetches advice stops delivery until resumed', async () => {
  const { call, poll, postToMainChat, setDashboard } = await load();
  await call({ action: 'watch', district: '09162' });
  setDashboard([NEW]);
  const fetchWarning = globalThis.fetch;
  vi.stubGlobal('fetch', async (url: string) => {
    if (url.includes('/warnings/')) await call({ action: 'pause' });
    return fetchWarning(url);
  });
  await poll();
  expect(postToMainChat).not.toHaveBeenCalled();
  vi.stubGlobal('fetch', fetchWarning);
  await call({ action: 'resume' });
  postToMainChat.mockReturnValueOnce(false);
  await poll();
  await poll();
  await poll();
  expect(postToMainChat).toHaveBeenCalledTimes(2);
});
