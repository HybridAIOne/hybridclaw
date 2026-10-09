import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { V0_39_1_BROWSER } from './fixtures/v0-39-1-browser-config.ts';
import { cleanupTrackedTempDirs } from './test-utils.ts';

/**
 * Vendor browser providers as plugins (#1801), through real gateway processes
 * started on v0.39.1-shaped configs. The managed browser pool and the Browser
 * Use Cloud API are local fakes that speak their HTTP protocol and hand out a
 * real Chromium over CDP. Needs `npm run build` and a Playwright Chromium.
 * HYBRIDCLAW_E2E_PORT_BASE pins every listener to ten ports from that base.
 */

const ROOT = path.resolve(import.meta.dirname, '..');
const CLI = path.join(ROOT, 'dist', 'cli.js');
const ENABLED =
  process.env.HYBRIDCLAW_RUN_BROWSER_PLUGIN_E2E === '1' && fs.existsSync(CLI);
const PORT_BASE = Number(process.env.HYBRIDCLAW_E2E_PORT_BASE) || 0;
const API_KEY = 'bu-e2e-key';
const POOL_TOKEN = 'pool-token';
const TOKEN = 'test-token';

let portsTaken = 0;
async function nextPort(): Promise<number> {
  if (PORT_BASE) return PORT_BASE + portsTaken++;
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body;
}

describe.skipIf(!ENABLED)('browser provider plugins in a real gateway', { timeout: 90_000 }, () => {
  const tempDirs: string[] = [];
  const servers: http.Server[] = [];
  const browsers: Array<{ close(): Promise<void> }> = [];
  const poolCalls: Array<{ call: string; body: Record<string, unknown> }> = [];
  const browserUseCalls: Array<{ call: string; body: Record<string, unknown> }> = [];
  const gateways: Array<{ child: ChildProcess; log: () => string }> = [];
  let pageUrl = '';
  let poolUrl = '';
  let browserUseUrl = '';
  type Gateway = { dataDir: string; url: string; log: () => string };
  let managed: Gateway;
  let browserUse: Gateway;
  let camofox: Gateway;

  async function listen(handler: http.RequestListener): Promise<string> {
    const port = await nextPort();
    const server = http.createServer(handler);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
    return `http://127.0.0.1:${port}`;
  }

  async function launchCdpBrowser(): Promise<string> {
    const cdpPort = await nextPort();
    browsers.push(
      await chromium.launch({ args: [`--remote-debugging-port=${cdpPort}`] }),
    );
    const version = (await (
      await fetch(`http://127.0.0.1:${cdpPort}/json/version`)
    ).json()) as { webSocketDebuggerUrl: string };
    return version.webSocketDebuggerUrl;
  }

  // Async, so the fakes in this process keep answering the gateway meanwhile.
  async function cli(dataDir: string, ...args: string[]): Promise<string> {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: ROOT,
      env: { ...process.env, HYBRIDCLAW_DATA_DIR: dataDir },
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      output += String(chunk);
    });
    const code = await new Promise<number | null>((resolve) =>
      child.once('exit', resolve),
    );
    if (code !== 0) throw new Error(`hybridclaw ${args.join(' ')}: ${output}`);
    return output;
  }

  async function post(
    gatewayUrl: string,
    route: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const response = await fetch(`${gatewayUrl}${route}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    return (await response.json()) as Record<string, unknown>;
  }

  const browserTool = (
    gatewayUrl: string,
    toolName: string,
    args: Record<string, unknown> = {},
  ) => post(gatewayUrl, '/api/browser/tool', { toolName, sessionId: 'e2e', agentId: 'main', args });

  const gatewayCommand = (gatewayUrl: string, args: string[]) =>
    post(gatewayUrl, '/api/command', {
      sessionId: 'e2e-cmd',
      guildId: null,
      channelId: 'web',
      args,
    });

  async function waitFor<T>(
    read: () => Promise<T>,
    done: (value: T) => boolean,
  ): Promise<T> {
    let last: T | undefined;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      last = await read().catch(() => undefined as T);
      if (last !== undefined && done(last)) return last;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const logs = gateways.map((gateway) => gateway.log()).join('\n---\n');
    throw new Error(`timed out; last=${JSON.stringify(last)}\n${logs}`);
  }

  /** A data dir holding a v0.39.1 config that selected `browser`'s provider. */
  async function startUpgradedGateway(
    browser: Record<string, unknown>,
    secrets: Record<string, string>,
  ): Promise<{ dataDir: string; url: string; log: () => string }> {
    const dataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-browser-plugins-e2e-'),
    );
    tempDirs.push(dataDir);
    const url = `http://127.0.0.1:${await nextPort()}`;
    fs.writeFileSync(
      path.join(dataDir, 'config.json'),
      JSON.stringify({
        ops: {
          healthPort: Number(new URL(url).port),
          gatewayBaseUrl: url,
          gatewayInternalBaseUrl: url,
          webApiToken: TOKEN,
        },
        container: { sandboxMode: 'host' },
        security: {
          trustModelAccepted: true,
          trustModelAcceptedAt: '2026-10-08T00:00:00Z',
          trustModelVersion: '2026-02-28',
        },
        browser: { ...V0_39_1_BROWSER, allowPrivateNetwork: true, ...browser },
      }),
    );
    for (const [name, value] of Object.entries(secrets)) {
      await cli(dataDir, 'secret', 'set', name, value);
    }
    // The gateway must see `config set` edits, so it keeps its watcher.
    const { HYBRIDCLAW_DISABLE_CONFIG_WATCHER: _watcher, ...env } = process.env;
    const child = spawn(process.execPath, [CLI, 'gateway', 'start', '--foreground'], {
      cwd: ROOT,
      env: { ...env, HYBRIDCLAW_DATA_DIR: dataDir },
    });
    let log = '';
    child.stdout?.on('data', (chunk) => {
      log += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      log += String(chunk);
    });
    gateways.push({ child, log: () => log });
    await waitFor(() => fetch(`${url}/health`).then((res) => res.ok), Boolean);
    return { dataDir, url, log: () => log };
  }

  beforeAll(async () => {
    pageUrl = `${await listen((_req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.end('<title>Plugin E2E</title><h1>served locally</h1>');
    })}/`;
    poolUrl = await listen(async (req, res) => {
      const body = await readBody(req);
      poolCalls.push({
        call: `${req.method} ${req.url}`,
        body: body ? JSON.parse(body) : {},
      });
      res.setHeader('Content-Type', 'application/json');
      if (req.headers.authorization !== `Bearer ${POOL_TOKEN}`) {
        res.statusCode = 401;
        res.end('{"ok":false}');
        return;
      }
      if (req.url === '/health') {
        res.end(JSON.stringify({ ok: true, nodes: [{ status: 'idle' }] }));
      } else if (req.method === 'POST' && req.url === '/leases') {
        const leaseId = `lease-${poolCalls.filter((entry) => entry.call === 'POST /leases').length}`;
        res.end(
          JSON.stringify({ leaseId, nodeId: 'node-1', cdpUrl: await launchCdpBrowser() }),
        );
      } else if (req.method === 'POST') {
        res.end(JSON.stringify({ verdict: 'allow' }));
      } else {
        res.end(JSON.stringify({ endedAt: new Date().toISOString() }));
      }
    });
    browserUseUrl = await listen(async (req, res) => {
      const body = await readBody(req);
      browserUseCalls.push({
        call: `${req.method} ${req.url}`,
        body: body ? JSON.parse(body) : {},
      });
      res.setHeader('Content-Type', 'application/json');
      if (req.headers['x-browser-use-api-key'] !== API_KEY) {
        res.statusCode = 401;
        res.end('{}');
        return;
      }
      if (req.method === 'POST') {
        res.statusCode = 201;
        res.end(
          JSON.stringify({
            id: 'bu-1',
            status: 'active',
            startedAt: new Date().toISOString(),
            cdpUrl: await launchCdpBrowser(),
          }),
        );
        return;
      }
      res.end(JSON.stringify({ id: 'bu-1', status: 'stopped' }));
    });

    [managed, browserUse, camofox] = await Promise.all([
      startUpgradedGateway(
        {
          provider: 'managed-cloud',
          managedCloud: {
            ...V0_39_1_BROWSER.managedCloud,
            endpointUrl: poolUrl,
            poolTokenRef: { source: 'store', id: 'MANAGED_BROWSER_POOL_TOKEN' },
          },
        },
        { MANAGED_BROWSER_POOL_TOKEN: POOL_TOKEN },
      ),
      startUpgradedGateway(
        {
          provider: 'browser-use-cloud',
          browserUseCloud: {
            ...V0_39_1_BROWSER.browserUseCloud,
            baseUrl: browserUseUrl,
          },
        },
        { BROWSER_USE_API_KEY: API_KEY },
      ),
      startUpgradedGateway({ provider: 'camofox' }, {}),
    ]);
  }, 120_000);

  afterAll(async () => {
    await Promise.all(
      gateways.map(
        ({ child }) =>
          new Promise<void>((resolve) => {
            if (child.exitCode !== null || child.signalCode !== null) {
              resolve();
              return;
            }
            child.once('exit', () => resolve());
            child.kill('SIGTERM');
          }),
      ),
    );
    await Promise.all(browsers.map((browser) => browser.close()));
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
            server.closeAllConnections();
          }),
      ),
    );
    cleanupTrackedTempDirs(tempDirs);
  });

  test('an upgraded managed-cloud config enables the bundled plugin and keeps its pool', async () => {
    const config = JSON.parse(
      fs.readFileSync(path.join(managed.dataDir, 'config.json'), 'utf8'),
    );
    expect(config.browser).not.toHaveProperty('managedCloud');
    expect(config.plugins.list).toContainEqual({
      id: 'managed-cloud',
      enabled: true,
      config: { endpointUrl: poolUrl },
    });

    expect(await gatewayCommand(managed.url, ['browser-pool', 'doctor'])).toMatchObject({
      kind: 'info',
      text: expect.stringContaining('Nodes: 1/1'),
    });
    expect(
      await cli(managed.dataDir, 'gateway', 'browser-pool', 'doctor'),
    ).toContain('Nodes: 1/1');
  });

  test('a pool session survives an unrelated plugin reload and is rebuilt when its own plugin changes', async () => {
    const leases = () =>
      poolCalls.filter((entry) => entry.call === 'POST /leases');
    const navigate = () =>
      waitFor(
        () => browserTool(managed.url, 'browser_navigate', { url: pageUrl }),
        (result) => result.success === true,
      );

    expect(await navigate()).toMatchObject({ title: 'Plugin E2E', headed: false });
    await gatewayCommand(managed.url, ['plugin', 'config', 'mac-cua', 'browser', 'safari']);
    await navigate();
    expect(leases()).toHaveLength(1);

    await gatewayCommand(managed.url, [
      'plugin',
      'config',
      'managed-cloud',
      'defaultTenantId',
      'tenant-b',
    ]);
    await navigate();
    expect(leases()).toHaveLength(2);
    expect(leases()[1]?.body).toMatchObject({ tenantId: 'tenant-b' });
    expect(poolCalls.map((entry) => entry.call)).toContain('DELETE /leases/lease-1');
  });

  test.each([
    ['GET', '/api/admin/browser-pool/health'],
    ['POST', '/api/admin/browser-pool/start'],
  ])('the removed %s %s route is gone', async (method, route) => {
    const response = await fetch(`${managed.url}${route}`, {
      method,
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(404);
  });

  test('an upgraded camofox config enables the bundled plugin, which names its install step', async () => {
    const config = JSON.parse(
      fs.readFileSync(path.join(camofox.dataDir, 'config.json'), 'utf8'),
    );
    expect(config.plugins.list).toContainEqual({
      id: 'camofox',
      enabled: true,
      config: { headed: false, launchOptions: {} },
    });
    expect(camofox.log()).toContain('hybridclaw plugin install camofox');

    // The bundled copy ships without camoufox-js.
    const result = await waitFor(
      () => browserTool(camofox.url, 'browser_navigate', { url: pageUrl }),
      (value) => typeof value.error === 'string',
    );
    expect(result.error).toContain('hybridclaw plugin install camofox');
    expect(result.error).toContain(path.join(camofox.dataDir, 'plugins', 'camofox'));
  });

  test('a provider plugin that failed to load reports its load error', async () => {
    // Saved by the CLI and loaded on reload; the gateway's own `plugin config`
    // would roll the bad value back instead.
    await cli(camofox.dataDir, 'plugin', 'config', 'camofox', 'launchOptions', '{"timeout":5}');
    // Reload until the gateway's config watcher has picked up the edit.
    const result = await waitFor(
      async () => {
        await gatewayCommand(camofox.url, ['plugin', 'reload']);
        return browserTool(camofox.url, 'browser_navigate', { url: pageUrl });
      },
      (value) => String(value.error || '').includes('failed to load'),
    );

    expect(result.error).toMatch(/camofox plugin failed to load: launchOptions\.timeout/u);
  });

  test('an unregistered provider fails instead of using the local browser', async () => {
    await cli(managed.dataDir, 'config', 'set', 'browser.provider', 'browserbase');
    const result = await waitFor(
      () => browserTool(managed.url, 'browser_navigate', { url: 'https://example.com/' }),
      (value) => /"browserbase" is not available/u.test(String(value.error || '')),
    );

    expect(result.error).toMatch(/hybridclaw plugin install browserbase/u);
  });

  test('an upgraded browser-use-cloud config drives a real browser with the plugin defaults', async () => {
    const navigated = await waitFor(
      () => browserTool(browserUse.url, 'browser_navigate', { url: pageUrl }),
      (result) => result.success === true,
    );
    expect(navigated).toMatchObject({ url: pageUrl, title: 'Plugin E2E' });
    expect(await browserTool(browserUse.url, 'browser_close')).toMatchObject({
      closed: true,
    });

    expect(browserUseCalls.map((entry) => entry.call)).toEqual([
      'POST /browsers',
      'PATCH /browsers/bu-1',
    ]);
    // v0.39.1 saved 1 for each unset session option; none reaches the API.
    expect(browserUseCalls[0]?.body).not.toHaveProperty('timeout');
    expect(browserUseCalls[0]?.body).not.toHaveProperty('browserScreenWidth');
    expect(browserUseCalls[0]?.body).not.toHaveProperty('browserScreenHeight');
  });
});
