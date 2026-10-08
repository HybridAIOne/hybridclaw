import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  getAvailablePort,
  waitForHealth,
} from './helpers/docker-test-setup.js';
import { cleanupTrackedTempDirs } from './test-utils.js';

// Full-binary e2e: the compiled CLI installs the distill plugin, then a real
// gateway (host sandbox, isolated data dir) serves its admin routes under
// scoped-token RBAC. Gated behind HYBRIDCLAW_RUN_CLI_E2E=1; needs a build.
const REPO = fileURLToPath(new URL('..', import.meta.url));
const CLI = path.join(REPO, 'dist', 'cli.js');
const RUN = process.env.HYBRIDCLAW_RUN_CLI_E2E === '1' && fs.existsSync(CLI);
const WEB_API_TOKEN = 'e2e-distill-token';

const tempDirs: string[] = [];
let gateway: ChildProcess | null = null;
let gatewayLog = '';
let baseUrl = '';
let env: NodeJS.ProcessEnv = {};

function runCli(args: string[]): string {
  return execFileSync(process.execPath, [CLI, ...args], {
    cwd: REPO,
    env,
    encoding: 'utf-8',
    timeout: 60_000,
  });
}

function createToken(label: string, actions: string): string {
  const out = runCli(['token', 'create', '--label', label, '--actions', actions]);
  const token = out.match(/^Token: (\S+)$/m)?.[1];
  if (!token) throw new Error(`No token in output:\n${out}`);
  return token;
}

async function api(
  token: string,
  method: string,
  route: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, any> }> {
  const response = await fetch(`${baseUrl}/api/admin/distill${route}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      origin: baseUrl,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : {} };
}

describe.skipIf(!RUN)('distill plugin on a real gateway', () => {
  beforeAll(async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-distill-e2e-'));
    tempDirs.push(root);
    const home = path.join(root, 'home');
    const dataDir = path.join(root, 'data');
    fs.mkdirSync(home);
    fs.mkdirSync(dataDir);
    const port = await getAvailablePort(
      Number(process.env.HYBRIDCLAW_E2E_PORT) || undefined,
    );
    baseUrl = `http://127.0.0.1:${port}`;
    fs.writeFileSync(
      path.join(dataDir, 'config.json'),
      JSON.stringify({
        ops: { healthPort: port, webApiToken: WEB_API_TOKEN },
        container: { sandboxMode: 'host' },
        // Unroutable so the gateway never calls the hosted HybridAI API.
        hybridai: { baseUrl: 'http://127.0.0.1:9' },
      }),
    );
    env = {
      PATH: process.env.PATH ?? '',
      HOME: home,
      HYBRIDCLAW_DATA_DIR: dataDir,
      HYBRIDCLAW_ACCEPT_TRUST: 'true',
    };

    expect(runCli(['plugin', 'install', './plugins/distill'])).toContain(
      'Installed plugin distill',
    );
    const source = path.join(root, 'memo.md');
    fs.writeFileSync(source, '# Memo\n\nBoring options win until measured.\n');
    runCli([
      'coworker',
      'distill',
      '--alias',
      'nova',
      '--name',
      'Nova',
      '--fictional',
      '--source',
      source,
      '--holdout',
      '0',
    ]);

    gateway = spawn(
      process.execPath,
      [CLI, 'gateway', 'start', '--foreground', '--sandbox=host'],
      { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    gateway.stdout?.on('data', (chunk) => {
      gatewayLog += chunk;
    });
    gateway.stderr?.on('data', (chunk) => {
      gatewayLog += chunk;
    });
    await waitForHealth(`${baseUrl}/health`, 45_000);
  }, 120_000);

  afterAll(async () => {
    if (gateway && gateway.exitCode === null) {
      const exited = new Promise((resolve) => gateway?.once('exit', resolve));
      gateway.kill('SIGTERM');
      await Promise.race([
        exited,
        new Promise((resolve) => setTimeout(resolve, 10_000)),
      ]);
      if (gateway.exitCode === null) gateway.kill('SIGKILL');
    }
    cleanupTrackedTempDirs(tempDirs);
  });

  test('the console API lists the subject the plugin CLI created', async () => {
    const listed = await api(WEB_API_TOKEN, 'GET', '');
    expect(listed.status, gatewayLog).toBe(200);
    expect(listed.json.subjects).toEqual([
      expect.objectContaining({ alias: 'nova', corpusDocuments: 1 }),
    ]);
  });

  test('scoped tokens get exactly the distill actions they hold', async () => {
    const reader = createToken('distill-reader', 'admin.distill.read');
    const other = createToken('overview', 'admin.overview.read');
    const subject = { alias: 'mira', displayName: 'Mira', realPerson: false };

    expect((await api(reader, 'GET', '')).status).toBe(200);
    expect((await api(reader, 'POST', '/subjects', subject)).status).toBe(403);
    expect((await api(other, 'GET', '')).status).toBe(403);
    expect((await api(WEB_API_TOKEN, 'POST', '/subjects', subject)).status).toBe(
      201,
    );
  });

  test('unknown methods and paths fail instead of reaching another route', async () => {
    expect((await api(WEB_API_TOKEN, 'PUT', '')).status).toBe(405);
    expect((await api(WEB_API_TOKEN, 'GET', '/nope')).status).toBe(404);
  });
});
