import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { cleanupTrackedTempDirs } from './test-utils.ts';

/**
 * Vendor browser providers as plugins (#1801), through a real gateway process:
 * a v0.39 config that selected managed-cloud keeps working after the upgrade,
 * a CLI-installed plugin drives a real Chromium behind a local fake of the
 * Browser Use Cloud API, and an unregistered kind fails instead of falling
 * back to the local browser. Needs `npm run build` and a Playwright Chromium.
 */

const ROOT = path.resolve(import.meta.dirname, '..');
const CLI = path.join(ROOT, 'dist', 'cli.js');
const ENABLED =
  process.env.HYBRIDCLAW_RUN_BROWSER_PLUGIN_E2E === '1' && fs.existsSync(CLI);
const API_KEY = 'bu-e2e-key';
const TOKEN = 'test-token';

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function listen(handler: http.RequestListener): Promise<{
  server: http.Server;
  url: string;
}> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  return { server, url: `http://127.0.0.1:${port}` };
}

describe.skipIf(!ENABLED)('browser provider plugins in a real gateway', { timeout: 60_000 }, () => {
  // One gateway serves every test, so its data dir lives until afterAll.
  const tempDirs: string[] = [];
  let dataDir = '';
  let gateway: ChildProcess | undefined;
  let gatewayUrl = '';
  let gatewayLog = '';
  const servers: http.Server[] = [];
  const browsers: Array<{ close(): Promise<void> }> = [];
  const browserUseCalls: string[] = [];

  function cli(...args: string[]): string {
    const result = spawnSync(process.execPath, [CLI, ...args], {
      cwd: ROOT,
      env: { ...process.env, HYBRIDCLAW_DATA_DIR: dataDir },
      encoding: 'utf8',
      timeout: 60_000,
    });
    if (result.status !== 0) {
      throw new Error(`hybridclaw ${args.join(' ')}: ${result.stderr}`);
    }
    return `${result.stdout}${result.stderr}`;
  }

  async function browserTool(
    toolName: string,
    args: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const response = await fetch(`${gatewayUrl}/api/browser/tool`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ toolName, sessionId: 'e2e', agentId: 'main', args }),
    });
    return (await response.json()) as Record<string, unknown>;
  }

  async function gatewayCommand(args: string[]) {
    const response = await fetch(`${gatewayUrl}/api/command`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ sessionId: 'e2e-cmd', guildId: null, channelId: 'web', args }),
    });
    return (await response.json()) as Record<string, unknown>;
  }

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
    throw new Error(`timed out; last=${JSON.stringify(last)}\n${gatewayLog}`);
  }

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-browser-plugins-e2e-'),
    );
    tempDirs.push(dataDir);
    const page = await listen((_req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.end('<title>Plugin E2E</title><h1>served locally</h1>');
    });
    const pool = await listen((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(
        req.headers.authorization === 'Bearer pool-token'
          ? JSON.stringify({ ok: true, nodes: [{ status: 'idle' }] })
          : JSON.stringify({ ok: false }),
      );
    });
    const browserUse = await listen(async (req, res) => {
      browserUseCalls.push(`${req.method} ${req.url}`);
      res.setHeader('Content-Type', 'application/json');
      if (req.headers['x-browser-use-api-key'] !== API_KEY) {
        res.statusCode = 401;
        res.end('{}');
        return;
      }
      if (req.method === 'POST') {
        const cdpPort = await freePort();
        browsers.push(
          await chromium.launch({ args: [`--remote-debugging-port=${cdpPort}`] }),
        );
        const version = (await (
          await fetch(`http://127.0.0.1:${cdpPort}/json/version`)
        ).json()) as { webSocketDebuggerUrl: string };
        res.statusCode = 201;
        res.end(
          JSON.stringify({
            id: 'bu-1',
            status: 'active',
            startedAt: new Date().toISOString(),
            cdpUrl: version.webSocketDebuggerUrl,
          }),
        );
        return;
      }
      res.end(JSON.stringify({ id: 'bu-1', status: 'stopped' }));
    });
    servers.push(page.server, pool.server, browserUse.server);
    process.env.HYBRIDCLAW_E2E_PAGE_URL = page.url;

    const port = await freePort();
    gatewayUrl = `http://127.0.0.1:${port}`;
    // A v0.39-shaped config: the vendor provider still lives under browser.*.
    fs.writeFileSync(
      path.join(dataDir, 'config.json'),
      JSON.stringify({
        ops: {
          healthPort: port,
          gatewayBaseUrl: gatewayUrl,
          gatewayInternalBaseUrl: gatewayUrl,
          webApiToken: TOKEN,
        },
        container: { sandboxMode: 'host' },
        security: {
          trustModelAccepted: true,
          trustModelAcceptedAt: '2026-10-08T00:00:00Z',
          trustModelVersion: '2026-02-28',
        },
        browser: {
          provider: 'managed-cloud',
          allowPrivateNetwork: true,
          managedCloud: {
            endpointUrl: pool.url,
            poolTokenRef: { source: 'store', id: 'MANAGED_BROWSER_POOL_TOKEN' },
          },
          macCua: { browser: 'chrome' },
        },
      }),
    );
    cli('secret', 'set', 'MANAGED_BROWSER_POOL_TOKEN', 'pool-token');
    cli('secret', 'set', 'BROWSER_USE_API_KEY', API_KEY);
    cli('plugin', 'install', './plugins/browser-use-cloud');
    cli('plugin', 'config', 'browser-use-cloud', 'baseUrl', browserUse.url);

    // The gateway must see `config set` edits, so it keeps its watcher.
    const { HYBRIDCLAW_DISABLE_CONFIG_WATCHER: _watcher, ...env } = process.env;
    gateway = spawn(process.execPath, [CLI, 'gateway', 'start', '--foreground'], {
      cwd: ROOT,
      env: { ...env, HYBRIDCLAW_DATA_DIR: dataDir },
    });
    gateway.stdout?.on('data', (chunk) => {
      gatewayLog += String(chunk);
    });
    gateway.stderr?.on('data', (chunk) => {
      gatewayLog += String(chunk);
    });
    await waitFor(
      () => fetch(`${gatewayUrl}/health`).then((res) => res.ok),
      Boolean,
    );
  }, 120_000);

  afterAll(async () => {
    gateway?.kill('SIGTERM');
    await Promise.all(browsers.map((browser) => browser.close()));
    await Promise.all(
      servers.map((server) => new Promise((resolve) => server.close(resolve))),
    );
    delete process.env.HYBRIDCLAW_E2E_PAGE_URL;
    cleanupTrackedTempDirs(tempDirs);
  });

  test('an upgraded managed-cloud config enables the bundled plugin and keeps its pool', async () => {
    const config = JSON.parse(
      fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'),
    );
    expect(config.browser).not.toHaveProperty('managedCloud');
    expect(config.plugins.list).toContainEqual(
      expect.objectContaining({ id: 'managed-cloud', enabled: true }),
    );

    const doctor = await gatewayCommand(['browser-pool', 'doctor']);
    expect(doctor).toMatchObject({
      kind: 'info',
      text: expect.stringContaining('Nodes: 1/1'),
    });
  });

  test('a CLI-installed plugin provider drives a real browser', async () => {
    cli('config', 'set', 'browser.provider', 'browser-use-cloud');
    const pageUrl = `${process.env.HYBRIDCLAW_E2E_PAGE_URL}/`;
    const navigated = await waitFor(
      () => browserTool('browser_navigate', { url: pageUrl }),
      (result) => result.success === true,
    );

    expect(navigated).toMatchObject({ url: pageUrl, title: 'Plugin E2E' });
    expect(await browserTool('browser_close')).toMatchObject({ closed: true });
    expect(browserUseCalls).toEqual(['POST /browsers', 'PATCH /browsers/bu-1']);
  });

  test('an unregistered provider fails instead of using the local browser', async () => {
    cli('config', 'set', 'browser.provider', 'browserbase');
    const result = await waitFor(
      () => browserTool('browser_navigate', { url: 'https://example.com/' }),
      (value) => typeof value.error === 'string',
    );

    expect(result.error).toMatch(
      /Browser provider "browserbase" is not available/u,
    );
  });
});
