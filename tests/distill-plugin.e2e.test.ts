import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import type http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  getAvailablePort,
  waitForHealth,
} from './helpers/docker-test-setup.js';
import { startScriptedModelServer } from './helpers/scripted-model-server.js';
import { cleanupTrackedTempDirs } from './test-utils.js';

// Full-binary e2e: a real gateway (host sandbox, isolated data dir, broken
// neighbour plugins installed) starts without the distill plugin, installs
// it at runtime through the gateway's own plugin command, and serves its
// admin routes under the real auth gate to scoped API tokens and scoped
// console sessions. An agent turn against a scripted OpenAI-compatible model
// runs `hybridclaw coworker` through its bash tool, as the human-distill
// skill does. Gated behind HYBRIDCLAW_RUN_CLI_E2E=1; needs a build.
const REPO = fileURLToPath(new URL('..', import.meta.url));
const CLI = path.join(REPO, 'dist', 'cli.js');
const RUN = process.env.HYBRIDCLAW_RUN_CLI_E2E === '1' && fs.existsSync(CLI);
const WEB_API_TOKEN = 'e2e-distill-token';
const AUTH_SECRET = 'e2e-distill-auth-secret';

const tempDirs: string[] = [];

interface GatewayHarness {
  root: string;
  dataDir: string;
  baseUrl: string;
  env: NodeJS.ProcessEnv;
  log: () => string;
  stop: () => Promise<void>;
}

async function startGateway(
  prepare?: (dataDir: string) => void,
  modelPort?: number,
): Promise<GatewayHarness> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-distill-e2e-'));
  tempDirs.push(root);
  const home = path.join(root, 'home');
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(home);
  fs.mkdirSync(dataDir);
  // `hybridclaw` on the agent's login-shell PATH, as a global npm install
  // with its bin directory in the user's profile provides it.
  const binDir = path.join(root, 'bin');
  fs.mkdirSync(binDir);
  fs.writeFileSync(
    path.join(binDir, 'hybridclaw'),
    `#!/bin/sh\nexec "${process.execPath}" "${CLI}" "$@"\n`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(home, '.profile'),
    `export PATH="${binDir}:$PATH"\n`,
  );
  const port = await getAvailablePort(
    Number(process.env.HYBRIDCLAW_E2E_PORT) || undefined,
  );
  const baseUrl = `http://127.0.0.1:${port}`;
  fs.writeFileSync(
    path.join(dataDir, 'config.json'),
    JSON.stringify({
      ops: { healthPort: port, webApiToken: WEB_API_TOKEN },
      container: { sandboxMode: 'host' },
      // Unroutable so the gateway never calls the hosted HybridAI API.
      hybridai: { baseUrl: 'http://127.0.0.1:9' },
      ...(modelPort
        ? {
            local: {
              backends: {
                vllm: {
                  enabled: true,
                  baseUrl: `http://127.0.0.1:${modelPort}/v1`,
                },
              },
            },
            agents: { defaults: { model: 'vllm/scripted' } },
          }
        : {}),
    }),
  );
  prepare?.(dataDir);
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: home,
    HYBRIDCLAW_DATA_DIR: dataDir,
    HYBRIDCLAW_ACCEPT_TRUST: 'true',
    HYBRIDCLAW_AUTH_SECRET: AUTH_SECRET,
    HYBRIDCLAW_DISABLE_CONFIG_WATCHER: '1',
  };
  let log = '';
  const gateway: ChildProcess = spawn(
    process.execPath,
    [CLI, 'gateway', 'start', '--foreground', '--sandbox=host'],
    { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  gateway.stdout?.on('data', (chunk) => {
    log += chunk;
  });
  gateway.stderr?.on('data', (chunk) => {
    log += chunk;
  });
  await waitForHealth(`${baseUrl}/health`, 45_000);
  return {
    root,
    dataDir,
    baseUrl,
    env,
    log: () => log,
    stop: async () => {
      if (gateway.exitCode !== null) return;
      const exited = new Promise((resolve) => gateway.once('exit', resolve));
      gateway.kill('SIGTERM');
      await Promise.race([
        exited,
        new Promise((resolve) => setTimeout(resolve, 10_000)),
      ]);
      if (gateway.exitCode === null) gateway.kill('SIGKILL');
    },
  };
}

function runCli(gw: GatewayHarness, args: string[]): string {
  return execFileSync(process.execPath, [CLI, ...args], {
    cwd: REPO,
    env: gw.env,
    encoding: 'utf-8',
    timeout: 60_000,
  });
}

function createToken(gw: GatewayHarness, label: string, actions: string) {
  const out = runCli(gw, [
    'token',
    'create',
    '--label',
    label,
    '--actions',
    actions,
  ]);
  const token = out.match(/^Token: (\S+)$/m)?.[1];
  if (!token) throw new Error(`No token in output:\n${out}`);
  return token;
}

// The hosted platform's launch hand-off: an HS256 launch token exchanged at
// /auth/callback for the gateway's own session cookie.
async function createScopedSession(
  gw: GatewayHarness,
  actions: string,
): Promise<string> {
  const segment = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${segment({ alg: 'HS256', typ: 'JWT' })}.${segment({
    sub: 'operator@example.com',
    actions,
    exp: Math.floor(Date.now() / 1000) + 600,
  })}`;
  const signature = createHmac('sha256', AUTH_SECRET)
    .update(unsigned)
    .digest('base64url');
  const response = await fetch(
    `${gw.baseUrl}/auth/callback?token=${unsigned}.${signature}`,
    { redirect: 'manual' },
  );
  expect(response.status).toBe(302);
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  if (!cookie) throw new Error('No session cookie');
  return cookie;
}

type Caller = { token: string } | { cookie: string };

async function api(
  gw: GatewayHarness,
  caller: Caller,
  method: string,
  route: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, any> }> {
  const response = await fetch(`${gw.baseUrl}/api/admin${route}`, {
    method,
    headers: {
      ...('token' in caller
        ? { authorization: `Bearer ${caller.token}` }
        : { cookie: caller.cookie }),
      origin: gw.baseUrl,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json: Record<string, any> = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { text };
  }
  return { status: response.status, json };
}

async function gatewayCommand(gw: GatewayHarness, args: string[]) {
  const response = await fetch(`${gw.baseUrl}/api/command`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${WEB_API_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      sessionId: 'e2e-plugin-admin',
      guildId: null,
      channelId: 'web',
      args,
    }),
  });
  const result = (await response.json()) as { kind: string; text: string };
  expect(result.kind, result.text).not.toBe('error');
  return result;
}

function writeNeighbourPlugin(dataDir: string, id: string, manifest: string) {
  const dir = path.join(dataDir, 'plugins', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'hybridclaw.plugin.yaml'),
    `id: ${id}\nversion: 1.0.0\nentrypoint: index.js\n${manifest}`,
  );
  fs.writeFileSync(
    path.join(dir, 'index.js'),
    `export default { id: '${id}', register() { throw new Error('boom'); } };\n`,
  );
}

// Answers the first turn with one `bash` call, then echoes its result.
async function startCoworkerAgentModel() {
  return startScriptedModelServer(
    (body) => {
      const last = body.messages.at(-1);
      if (!body.tools?.length) return { role: 'assistant', content: 'ok' };
      if (last?.role === 'tool') {
        return { role: 'assistant', content: String(last.content) };
      }
      return {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_coworker_status',
            type: 'function',
            function: {
              name: 'bash',
              arguments: JSON.stringify({
                command: 'hybridclaw coworker status --alias nova',
              }),
            },
          },
        ],
      };
    },
    { model: 'scripted' },
  );
}

describe.skipIf(!RUN)('distill plugin on a real gateway', () => {
  const web: Caller = { token: WEB_API_TOKEN };
  let model: http.Server | undefined;
  let gw: GatewayHarness;
  let reader: Caller;
  let writer: Caller;
  let overview: Caller;
  let readerSession: Caller;

  beforeAll(async () => {
    const scripted = await startCoworkerAgentModel();
    model = scripted.server;
    gw = await startGateway((dataDir) => {
      writeNeighbourPlugin(dataDir, 'throws-on-register', '');
      writeNeighbourPlugin(
        dataDir,
        'needs-secret',
        'requires:\n  env: [DISTILL_E2E_UNSET_SECRET]\n',
      );
    }, scripted.port);
    reader = { token: createToken(gw, 'distill-reader', 'admin.distill.read') };
    writer = {
      token: createToken(
        gw,
        'distill-writer',
        'admin.distill.read,admin.distill.write,admin.distill.delete',
      ),
    };
    overview = { token: createToken(gw, 'overview', 'admin.overview.read') };
    readerSession = {
      cookie: await createScopedSession(gw, 'admin.distill.read'),
    };
  }, 120_000);

  afterAll(async () => {
    await gw?.stop();
    await new Promise((resolve) => model?.close(resolve));
    cleanupTrackedTempDirs(tempDirs);
  });

  test('before install, every caller is told the API is missing, not forbidden', async () => {
    for (const caller of [web, reader, readerSession, overview]) {
      expect((await api(gw, caller, 'GET', '/distill')).status).toBe(404);
    }
    // Deny-by-default for scoped callers outside the plugin namespace holds.
    expect((await api(gw, readerSession, 'GET', '/plugins')).status).toBe(403);
    expect((await api(gw, reader, 'GET', '/plugins')).status).toBe(403);
  });

  test('installing through the gateway serves the routes without a restart and tracks the package', async () => {
    await gatewayCommand(gw, ['plugin', 'install', 'distill']);
    expect(fs.existsSync(path.join(gw.dataDir, 'plugins', 'distill'))).toBe(
      false,
    );
    const plugins = await api(gw, web, 'GET', '/plugins');
    expect(
      plugins.json.plugins.find((plugin: { id: string }) => plugin.id === 'distill'),
    ).toMatchObject({ source: 'bundled', status: 'loaded' });
    expect((await api(gw, reader, 'GET', '/distill')).status).toBe(200);
    expect((await api(gw, readerSession, 'GET', '/distill')).status).toBe(200);
  });

  test('the CLI writes only its own output next to broken plugins, and the console API sees it', async () => {
    const source = path.join(gw.root, 'memo.md');
    fs.writeFileSync(source, '# Memo\n\nBoring options win until measured.\n');
    const out = runCli(gw, [
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
    expect(out.startsWith('Created coworker subject `nova`')).toBe(true);
    expect(out).not.toMatch(/WARN|boom/);

    const listed = await api(gw, web, 'GET', '/distill');
    expect(listed.status, gw.log()).toBe(200);
    expect(listed.json.subjects).toEqual([
      expect.objectContaining({ alias: 'nova', corpusDocuments: 1 }),
    ]);
  });

  test('an agent turn reaches the plugin CLI through its bash tool, as the human-distill skill does', async () => {
    const response = await fetch(`${gw.baseUrl}/api/chat`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${WEB_API_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        sessionId: 'e2e-distill-skill',
        content: 'Use the human-distill skill: show the status of coworker nova.',
      }),
      signal: AbortSignal.timeout(90_000),
    });
    const result = (await response.json()) as {
      status: string;
      result?: string;
      toolExecutions?: Array<{ name: string; isError?: boolean }>;
    };
    expect(result.status, JSON.stringify(result)).toBe('success');
    expect(result.toolExecutions).toEqual([
      expect.objectContaining({ name: 'bash', isError: false }),
    ]);
    expect(result.result).toContain('Coworker: Nova (`nova`)');
    expect(result.result).toContain('Corpus: 1 documents');
  }, 120_000);

  test('scoped tokens and sessions get exactly the distill actions they hold', async () => {
    const subject = { alias: 'mira', displayName: 'Mira', realPerson: false };
    expect((await api(gw, reader, 'POST', '/distill/subjects', subject)).status).toBe(403);
    expect(
      (await api(gw, readerSession, 'POST', '/distill/subjects', subject)).status,
    ).toBe(403);
    expect((await api(gw, overview, 'GET', '/distill')).status).toBe(403);
    expect((await api(gw, writer, 'POST', '/distill/subjects', subject)).status).toBe(201);

    const register = { alias: 'nova' };
    expect((await api(gw, reader, 'POST', '/distill/register', register)).status).toBe(403);
    expect(
      (await api(gw, readerSession, 'POST', '/distill/register', register)).status,
    ).toBe(403);
    const registered = await api(gw, writer, 'POST', '/distill/register', register);
    expect(registered.status).toBe(201);
    expect(registered.json.subject).toMatchObject({ registeredAgent: true });

    const listed = await api(gw, web, 'GET', '/distill');
    const docId = listed.json.subjects.find(
      (entry: { alias: string }) => entry.alias === 'nova',
    ).corpus[0].id;
    const doc = `/distill/corpus/${docId}?alias=nova`;
    expect((await api(gw, readerSession, 'GET', doc)).status).toBe(200);
    expect((await api(gw, reader, 'DELETE', doc)).status).toBe(403);
    expect((await api(gw, readerSession, 'DELETE', doc)).status).toBe(403);
    expect((await api(gw, writer, 'DELETE', doc)).status).toBe(200);
    expect((await api(gw, reader, 'GET', doc)).status).toBe(404);
  });

  test('unknown methods and paths fail instead of reaching another route', async () => {
    expect((await api(gw, web, 'PUT', '/distill')).status).toBe(405);
    expect((await api(gw, web, 'GET', '/distill/nope')).status).toBe(404);
  });

  test('disabling and re-enabling at runtime removes and restores the routes', async () => {
    await gatewayCommand(gw, ['plugin', 'disable', 'distill']);
    for (const caller of [web, reader, readerSession]) {
      expect((await api(gw, caller, 'GET', '/distill')).status).toBe(404);
    }
    await gatewayCommand(gw, ['plugin', 'enable', 'distill']);
    for (const caller of [web, reader, readerSession]) {
      expect((await api(gw, caller, 'GET', '/distill')).status).toBe(200);
    }
  });
});

describe.skipIf(!RUN)('upgrading with a home copy of distill installed', () => {
  let gw: GatewayHarness;

  beforeAll(async () => {
    gw = await startGateway((dataDir) => {
      // What an older release left behind: a copy in the runtime home.
      const homeCopy = path.join(dataDir, 'plugins', 'distill');
      fs.cpSync(path.join(REPO, 'plugins', 'distill'), homeCopy, {
        recursive: true,
      });
      const manifest = path.join(homeCopy, 'hybridclaw.plugin.yaml');
      fs.writeFileSync(
        manifest,
        fs
          .readFileSync(manifest, 'utf-8')
          .replace(/^version: .*$/m, 'version: 0.0.1'),
      );
    });
  }, 120_000);

  afterAll(async () => {
    await gw?.stop();
    cleanupTrackedTempDirs(tempDirs);
  });

  test('reinstall swaps the stale copy for the packaged plugin without a restart', async () => {
    const web: Caller = { token: WEB_API_TOKEN };
    const distill = async () =>
      (await api(gw, web, 'GET', '/plugins')).json.plugins.find(
        (plugin: { id: string }) => plugin.id === 'distill',
      );
    expect(await distill()).toMatchObject({ version: '0.0.1', source: 'home' });

    await gatewayCommand(gw, ['plugin', 'reinstall', 'distill']);
    const bundledVersion = fs
      .readFileSync(
        path.join(REPO, 'plugins', 'distill', 'hybridclaw.plugin.yaml'),
        'utf-8',
      )
      .match(/^version: (.*)$/m)?.[1];
    expect(await distill()).toMatchObject({
      version: bundledVersion,
      source: 'bundled',
      status: 'loaded',
    });
    expect(fs.existsSync(path.join(gw.dataDir, 'plugins', 'distill'))).toBe(
      false,
    );
    expect((await api(gw, web, 'GET', '/distill')).status).toBe(200);
  });
});
