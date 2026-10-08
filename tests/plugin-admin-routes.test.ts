import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { PluginAdminRouteRegistry } from '../src/plugins/plugin-admin-routes.js';
import {
  normalizeManifestCliCommands,
  PluginCliCommandRegistry,
} from '../src/plugins/plugin-cli-commands.js';
import type { PluginAdminRouteDefinition } from '../src/plugins/plugin-types.js';
import { useCleanMocks } from './test-utils.js';

useCleanMocks({ resetModules: true });

function route(
  overrides: Partial<PluginAdminRouteDefinition> = {},
): PluginAdminRouteDefinition {
  return {
    method: 'GET',
    path: '/api/admin/demo',
    rbacAction: 'admin.overview.read',
    handler: () => {},
    ...overrides,
  };
}

describe('PluginAdminRouteRegistry', () => {
  test.each([
    ['an unsupported method', { method: 'PATCH' }, /unsupported method/],
    [
      'an action outside the RBAC catalog',
      { rbacAction: 'admin.demo.anything' },
      /unknown rbacAction/,
    ],
    ['a path outside its namespace', { path: '/api/admin/other' }, /under/],
    ['a sibling-prefix path', { path: '/api/admin/demo-x' }, /under/],
    ['an empty segment', { path: '/api/admin/demo//x' }, /segment/],
    ['a core admin route', { path: '/api/admin/agents' }, /under/],
    ['a missing handler', { handler: undefined }, /handler/],
  ])('rejects %s', (_label, overrides, message) => {
    const registry = new PluginAdminRouteRegistry();
    expect(() =>
      registry.register(
        'demo',
        route(overrides as Partial<PluginAdminRouteDefinition>),
      ),
    ).toThrow(message);
  });

  test('rejects a plugin whose namespace is a core admin route', () => {
    const registry = new PluginAdminRouteRegistry();
    expect(() =>
      registry.register(
        'agents',
        route({ path: '/api/admin/agents', rbacAction: 'admin.agents.read' }),
      ),
    ).toThrow(/already a core admin route/);
  });

  test.each([
    '/api/admin/demo/items/:id',
    '/api/admin/demo/items/:key',
    '/api/admin/demo/items/new',
  ])('rejects %s overlapping a registered route', (path) => {
    const registry = new PluginAdminRouteRegistry();
    registry.register('demo', route({ path: '/api/admin/demo/items/:id' }));
    expect(() => registry.register('demo', route({ path }))).toThrow(
      /overlaps/,
    );
    registry.register('demo', route({ method: 'DELETE', path }));
  });

  test('matches exact paths and decodes params, never another route', () => {
    const registry = new PluginAdminRouteRegistry();
    const list = route();
    const item = route({ path: '/api/admin/demo/items/:id' });
    registry.register('demo', list);
    registry.register('demo', item);

    expect(registry.match('get', '/api/admin/demo')).toMatchObject({
      kind: 'route',
      params: {},
    });
    const matched = registry.match('GET', '/api/admin/demo/items/a%20b');
    expect(matched).toMatchObject({ kind: 'route', params: { id: 'a b' } });
    expect(matched?.kind === 'route' && matched.entry.route.handler).toBe(
      item.handler,
    );
    expect(registry.match('POST', '/api/admin/demo')).toEqual({
      kind: 'method-not-allowed',
    });
    expect(registry.match('GET', '/api/admin/demo/items/%E0%A4%A')).toEqual({
      kind: 'bad-path',
    });
    expect(registry.match('GET', '/api/admin/demo/items')).toBeNull();
    expect(registry.match('GET', '/api/admin/demo/items/a/b')).toBeNull();
    expect(registry.match('GET', '/api/admin/demo/items/')).toBeNull();
  });

  test('restores a snapshot taken before a failed registration', () => {
    const registry = new PluginAdminRouteRegistry();
    const snapshot = registry.snapshot();
    registry.register('demo', route());
    registry.restore(snapshot);
    expect(registry.match('GET', '/api/admin/demo')).toBeNull();
  });
});

describe('PluginCliCommandRegistry', () => {
  const declared = [{ name: 'demo', description: 'Demo' }];

  test.each([
    ['an uppercase name', { name: 'Coworker' }, /lowercase/],
    ['a flag-like name', { name: '--help' }, /lowercase/],
    ['a name the manifest does not declare', { name: 'other' }, /not declared/],
    ['a missing run', { run: undefined }, /no run/],
  ])('rejects %s', (_label, overrides, message) => {
    const registry = new PluginCliCommandRegistry();
    expect(() =>
      registry.register(
        'demo',
        { name: 'demo', run: () => {}, ...(overrides as object) },
        declared,
      ),
    ).toThrow(message);
  });

  test('keeps one owner per command name', () => {
    const registry = new PluginCliCommandRegistry();
    const run = vi.fn();
    registry.register('a', { name: 'demo', run }, declared);
    expect(() => registry.register('b', { name: 'demo', run }, declared)).toThrow(
      /already registered by "a"/,
    );
    expect(registry.find('demo')?.pluginId).toBe('a');
    expect(registry.find('other')).toBeUndefined();
  });

  test.each([
    ['a non-list', 'coworker', /must be a list/],
    ['a bad name', [{ name: 'Co', description: 'x' }], /lowercase/],
    ['a missing description', [{ name: 'demo' }], /needs a description/],
    [
      'a duplicate',
      [
        { name: 'demo', description: 'x' },
        { name: 'demo', description: 'y' },
      ],
      /twice/,
    ],
  ])('manifest cliCommands rejects %s', (_label, value, message) => {
    expect(() => normalizeManifestCliCommands('demo', value)).toThrow(message);
  });

  test('manifest cliCommands keeps name and description', () => {
    expect(
      normalizeManifestCliCommands('demo', [
        { name: ' demo ', description: ' Demo command ' },
      ]),
    ).toEqual([{ name: 'demo', description: 'Demo command' }]);
    expect(normalizeManifestCliCommands('demo', undefined)).toBeUndefined();
  });
});

describe('gateway plugin admin route dispatch', () => {
  let server: http.Server | null = null;

  afterEach(async () => {
    if (server) await new Promise((resolve) => server?.close(resolve));
    server = null;
  });

  async function serveDemoPlugin(handler: PluginAdminRouteDefinition['handler']) {
    const { getPluginManager } = await import(
      '../src/plugins/plugin-manager.js'
    );
    const gateway = await import('../src/gateway/gateway-plugin-admin-routes.js');
    getPluginManager().adminRoutes.register(
      'demo',
      route({ path: '/api/admin/demo/items/:id', handler }),
    );
    server = http.createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://localhost');
      void gateway.handleGatewayPluginAdminRoute(req, res, url).then(
        (handled) => {
          if (!handled) {
            res.writeHead(404);
            res.end('core 404');
          }
        },
        (error: Error) => {
          res.writeHead(500);
          res.end(error.message);
        },
      );
    });
    await new Promise<void>((resolve) =>
      server?.listen(0, '127.0.0.1', resolve),
    );
    const { port } = server.address() as AddressInfo;
    return { base: `http://127.0.0.1:${port}`, gateway };
  }

  test('resolves the RBAC action only for a registered method and path', async () => {
    const { gateway } = await serveDemoPlugin(() => {});
    expect(
      gateway.resolvePluginAdminRouteAction('/api/admin/demo/items/1', 'GET'),
    ).toBe('admin.overview.read');
    expect(
      gateway.resolvePluginAdminRouteAction('/api/admin/demo/items/1', 'POST'),
    ).toBeNull();
    expect(
      gateway.resolvePluginAdminRouteAction('/api/admin/demo', 'GET'),
    ).toBeNull();
  });

  test('passes params to the handler and maps WebhookHttpError to its status', async () => {
    const { WebhookHttpError } = await import(
      '../src/channels/webhook-http.js'
    );
    const { base } = await serveDemoPlugin(({ res, params, pluginId }) => {
      if (params.id === 'missing') throw new WebhookHttpError(404, 'gone');
      if (params.id === 'crash') throw new Error('boom');
      if (params.id === 'silent') return;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ id: params.id, pluginId }));
    });

    const ok = await fetch(`${base}/api/admin/demo/items/a%2Fb`);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ id: 'a/b', pluginId: 'demo' });

    const missing = await fetch(`${base}/api/admin/demo/items/missing`);
    expect([missing.status, await missing.json()]).toEqual([
      404,
      { error: 'gone' },
    ]);

    const crash = await fetch(`${base}/api/admin/demo/items/crash`);
    expect([crash.status, await crash.text()]).toEqual([500, 'boom']);

    expect((await fetch(`${base}/api/admin/demo/items/silent`)).status).toBe(
      204,
    );
    expect(
      (await fetch(`${base}/api/admin/demo/items/1`, { method: 'PUT' }))
        .status,
    ).toBe(405);
    const unknown = await fetch(`${base}/api/admin/demo/other`);
    expect([unknown.status, await unknown.text()]).toEqual([404, 'core 404']);
  });
});
