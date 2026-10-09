import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import WebSocket from 'ws';
import { brokenNodePty, nodePtyLoads } from './helpers/broken-node-pty.js';
import {
  getAvailablePort,
  waitForHealth,
} from './helpers/docker-test-setup.js';
import { cleanupTrackedTempDirs } from './test-utils.js';

// Full-binary e2e for the admin terminal: boots the compiled gateway
// (dist/cli.js, plus the esbuild bundle/cli.js the Docker image runs when it
// has been built) in host-sandbox mode with an isolated data dir and HOME, then
// drives POST /api/admin/terminal and its websocket stream. Gated behind
// HYBRIDCLAW_RUN_CLI_E2E=1; needs `npm run build`. The real-PTY cases run only
// where node-pty's native addon loads; CI builds it, and the bundle, in a
// separate step after the console e2e has booted a gateway without it.
const RUN = process.env.HYBRIDCLAW_RUN_CLI_E2E === '1';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const DIST_CLI = path.join(REPO, 'dist', 'cli.js');
const BUNDLE_CLI = path.join(REPO, 'bundle', 'cli.js');
const ENTRYPOINTS = fs.existsSync(BUNDLE_CLI)
  ? [DIST_CLI, BUNDLE_CLI]
  : [DIST_CLI];
const WEB_API_TOKEN = 'e2e-terminal-token';
const STARTUP_TIMEOUT_MS = 45_000;
const STOP_TIMEOUT_MS = 10_000;

type RunningGateway = {
  baseUrl: string;
  log: () => string;
  child: ChildProcess;
  repairNodePty: () => void;
};

const tempDirs: string[] = [];
let gateway: RunningGateway | null = null;

async function startGateway(
  cli: string,
  options: { breakNodePty?: boolean } = {},
): Promise<RunningGateway> {
  expect(fs.existsSync(cli), 'run `npm run build` first').toBe(true);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-terminal-e2e-'));
  tempDirs.push(root);
  const home = path.join(root, 'home');
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(home);
  fs.mkdirSync(dataDir);
  const port = await getAvailablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  fs.writeFileSync(
    path.join(dataDir, 'config.json'),
    JSON.stringify({
      ops: {
        healthPort: port,
        gatewayBaseUrl: baseUrl,
        gatewayInternalBaseUrl: baseUrl,
      },
      // Unroutable so the gateway never calls the hosted HybridAI API.
      hybridai: { baseUrl: 'http://127.0.0.1:9' },
    }),
  );
  const broken = options.breakNodePty ? brokenNodePty(root) : null;
  let log = '';
  const child = spawn(
    process.execPath,
    [
      ...(broken?.nodeArgs ?? []),
      cli,
      'gateway',
      'start',
      '--foreground',
      '--sandbox=host',
    ],
    {
      cwd: root,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: home,
        HYBRIDCLAW_DATA_DIR: dataDir,
        HYBRIDCLAW_ACCEPT_TRUST: 'true',
        HYBRIDAI_API_KEY: 'hai-e2e-placeholder',
        WEB_API_TOKEN,
        ...broken?.env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child.stdout?.on('data', (chunk) => {
    log += chunk;
  });
  child.stderr?.on('data', (chunk) => {
    log += chunk;
  });
  gateway = {
    baseUrl,
    child,
    log: () => log,
    repairNodePty: () => broken?.repair(),
  };
  const exited = new Promise<never>((_, reject) => {
    child.once('exit', (code) =>
      reject(new Error(`gateway exited with code ${code} before /health`)),
    );
  });
  try {
    await Promise.race([
      waitForHealth(`${baseUrl}/health`, STARTUP_TIMEOUT_MS),
      exited,
    ]);
  } catch (error) {
    console.error('--- gateway log ---\n', log);
    throw error;
  }
  return gateway;
}

async function stopGateway(): Promise<void> {
  const child = gateway?.child;
  gateway = null;
  if (!child || child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), STOP_TIMEOUT_MS);
  await exited;
  clearTimeout(timer);
}

function terminalRequest(
  running: RunningGateway,
  init: { method: 'POST' | 'DELETE'; query?: string },
): Promise<Response> {
  return fetch(
    `${running.baseUrl}/api/admin/terminal${init.query ? `?${init.query}` : ''}`,
    {
      method: init.method,
      headers: {
        Authorization: `Bearer ${WEB_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: init.method === 'POST' ? JSON.stringify({ cols: 100 }) : undefined,
    },
  );
}

async function expectLivePtySession(running: RunningGateway): Promise<void> {
  const response = await terminalRequest(running, { method: 'POST' });
  expect(response.status).toBe(200);
  const started = (await response.json()) as {
    sessionId: string;
    websocketPath: string;
  };
  expect(started.websocketPath).toContain(started.sessionId);

  const ws = new WebSocket(
    `${running.baseUrl.replace('http', 'ws')}${started.websocketPath}`,
  );
  let output = '';
  ws.on('message', (raw) => {
    const message = JSON.parse(String(raw)) as {
      type: string;
      data?: string;
    };
    if (message.type === 'output') output += message.data ?? '';
  });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  ws.send(JSON.stringify({ type: 'auth', token: WEB_API_TOKEN }));

  await expect
    .poll(() => output.length, { timeout: 30_000 })
    .toBeGreaterThan(0);
  const beforeInput = output.length;
  ws.send(JSON.stringify({ type: 'input', data: '/help\r' }));
  await expect
    .poll(() => output.length, { timeout: 15_000 })
    .toBeGreaterThan(beforeInput);

  const stopped = await terminalRequest(running, {
    method: 'DELETE',
    query: `sessionId=${encodeURIComponent(started.sessionId)}`,
  });
  expect(await stopped.json()).toEqual({ stopped: true });
  ws.close();
}

describe.skipIf(!RUN).each(ENTRYPOINTS.map((cli) => path.relative(REPO, cli)))(
  'admin terminal against a live %s gateway',
  (entrypoint) => {
    const cli = path.join(REPO, entrypoint);

    afterEach(async () => {
      await stopGateway();
      cleanupTrackedTempDirs(tempDirs);
    }, STOP_TIMEOUT_MS + 5_000);

    test('boots without a loadable node-pty and fails only the terminal request', async () => {
      const running = await startGateway(cli, { breakNodePty: true });

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await terminalRequest(running, { method: 'POST' });
        expect(response.status).toBe(503);
        const body = (await response.json()) as { error?: string };
        expect(body.error).toContain('npm rebuild node-pty');
      }

      const health = await fetch(`${running.baseUrl}/health`);
      expect(health.status).toBe(200);
      expect(running.child.exitCode).toBeNull();
      expect(running.log()).toContain(
        'Unable to load node-pty; admin terminal unavailable',
      );
    }, 90_000);

    test.skipIf(!nodePtyLoads())(
      'streams a real PTY session over the websocket after the lazy load',
      async () => {
        const running = await startGateway(cli);

        await expectLivePtySession(running);

        const health = await fetch(`${running.baseUrl}/health`);
        expect(health.status).toBe(200);
        expect(running.log()).not.toContain('Unable to load node-pty');
      },
      90_000,
    );

    test.skipIf(!nodePtyLoads())(
      'starts a real PTY once node-pty is repaired, without a gateway restart',
      async () => {
        const running = await startGateway(cli, { breakNodePty: true });
        const failed = await terminalRequest(running, { method: 'POST' });
        expect(failed.status).toBe(503);

        running.repairNodePty();

        await expectLivePtySession(running);
        expect(running.child.exitCode).toBeNull();
      },
      90_000,
    );
  },
);
