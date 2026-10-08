import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { AdminMSTeamsUser } from '../console/src/api/types.js';
import {
  getAvailablePort,
  waitForHealth,
} from './helpers/docker-test-setup.js';
import { cleanupTrackedTempDirs } from './test-utils.js';

// The compiled gateway (dist/cli.js) receives Bot Framework activities on its
// real Teams webhook and records senders in channel_users. Faked: Microsoft's
// Bot Connector and the LLM (an LM Studio-compatible server), both local; Bot
// Framework auth runs in botbuilder's own "authentication disabled" mode via a
// preload. Gated behind HYBRIDCLAW_RUN_MSTEAMS_E2E=1; needs `npm run build`.
const RUN = process.env.HYBRIDCLAW_RUN_MSTEAMS_E2E === '1';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const CLI = path.join(REPO, 'dist', 'cli.js');
const WEB_API_TOKEN = 'e2e-teams-token';
const TENANT = '72f988bf-86f1-41af-91ab-2d7cd011db47';
const STARTUP_TIMEOUT_MS = 45_000;
const TURN_TIMEOUT_MS = 30_000;

const ERIKA = {
  teamsId: '29:1erika-teams-id',
  aadObjectId: '3F2504E0-4F89-11D3-9A0C-0305E82C3301',
  name: 'Erika Example',
  email: 'erika@example.com',
};

// The console's AdminMSTeamsUser keys; `satisfies` flags drift when this file
// is type-checked. The live payload must carry exactly these keys.
const CONSOLE_USER_KEYS = Object.keys({
  tenantId: true,
  userId: true,
  teamsUserId: true,
  entraObjectId: true,
  displayName: true,
  agentId: true,
  messageCount: true,
  sessionCount: true,
  totalTokens: true,
  costUsd: true,
  firstSeen: true,
  lastSeen: true,
} satisfies Record<keyof AdminMSTeamsUser, true>).sort();

const tempDirs: string[] = [];
const servers: http.Server[] = [];
let gateway: ChildProcess | null = null;
let gatewayLog = '';
let baseUrl = '';
let dbPath = '';
let connectorUrl = '';
const getMemberCalls: string[] = [];
const sentTexts: string[] = [];

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => resolve(body));
  });
}

async function listen(
  handler: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: string,
  ) => void,
): Promise<string> {
  const server = http.createServer(async (req, res) => {
    handler(req, res, await readBody(req));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

// Bot Framework REST: GET members/{id} (TeamsInfo.getMember) and activity posts.
function connector(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  body: string,
): void {
  const member = req.url?.match(/\/v3\/conversations\/[^/]+\/members\/([^/?]+)/);
  if (req.method === 'GET' && member) {
    const id = decodeURIComponent(member[1]);
    getMemberCalls.push(id);
    if (id !== ERIKA.teamsId) return json(res, 404, {});
    return json(res, 200, {
      id: ERIKA.teamsId,
      aadObjectId: ERIKA.aadObjectId,
      name: ERIKA.name,
      email: ERIKA.email,
      userPrincipalName: ERIKA.email,
    });
  }
  if (/\/activities/.test(req.url ?? '')) {
    sentTexts.push(String((JSON.parse(body || '{}') as { text?: string }).text));
    return json(res, 200, { id: `bot-activity-${sentTexts.length}` });
  }
  json(res, 200, {});
}

function model(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  body: string,
): void {
  if (req.method === 'GET' && req.url?.endsWith('/models')) {
    return json(res, 200, { object: 'list', data: [{ id: 'fake-model' }] });
  }
  if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
    return json(res, 404, {});
  }
  const usage = { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 };
  const content = 'Hello from the fake model.';
  if (!(JSON.parse(body) as { stream?: boolean }).stream) {
    return json(res, 200, {
      id: 'c1',
      object: 'chat.completion',
      model: 'fake-model',
      choices: [
        { index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' },
      ],
      usage,
    });
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const chunk of [
    { choices: [{ index: 0, delta: { role: 'assistant', content } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    { choices: [], usage },
  ]) {
    res.write(
      `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', model: 'fake-model', ...chunk })}\n\n`,
    );
  }
  res.end('data: [DONE]\n\n');
}

let activitySeq = 0;
async function sendActivity(extra: Record<string, unknown>): Promise<number> {
  activitySeq += 1;
  const response = await fetch(`${baseUrl}/api/msteams/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: `user-activity-${activitySeq}`,
      timestamp: new Date().toISOString(),
      serviceUrl: `${connectorUrl}/`,
      channelId: 'msteams',
      from: {
        id: ERIKA.teamsId,
        name: ERIKA.name,
        aadObjectId: ERIKA.aadObjectId,
      },
      recipient: { id: '28:e2e-bot', name: 'Bot' },
      conversation: {
        id: 'a:1personal-erika',
        conversationType: 'personal',
        tenantId: TENANT,
      },
      channelData: { tenant: { id: TENANT } },
      ...extra,
    }),
  });
  return response.status;
}

function query<T>(sql: string, ...params: unknown[]): T[] {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return db.prepare(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}

const usageAgents = () =>
  query<{ agent_id: string }>(
    "SELECT agent_id FROM usage_events WHERE channel_kind = 'msteams' AND user_id = ? ORDER BY timestamp",
    ERIKA.aadObjectId,
  ).map((row) => row.agent_id);

async function sendMessage(text: string): Promise<void> {
  const before = usageAgents().length;
  expect(await sendActivity({ type: 'message', text, textFormat: 'plain' })).toBe(
    200,
  );
  await expect
    .poll(() => usageAgents().length, { timeout: TURN_TIMEOUT_MS })
    .toBe(before + 1);
}

async function admin(
  method: string,
  pathname: string,
  body?: unknown,
  token = WEB_API_TOKEN,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: response.status,
    body: (await response.json().catch(() => ({}))) as Record<string, unknown>,
  };
}

async function erikaRow(): Promise<Record<string, unknown>> {
  const { status, body } = await admin('GET', '/api/admin/msteams/users');
  expect(status).toBe(200);
  const users = body.users as Array<Record<string, unknown>>;
  const row = users.find((user) => user.userId === ERIKA.aadObjectId);
  expect(row).toBeDefined();
  return row as Record<string, unknown>;
}

async function startGateway(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-teams-e2e-'));
  tempDirs.push(root);
  const home = path.join(root, 'home');
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(home);
  fs.mkdirSync(dataDir);
  dbPath = path.join(dataDir, 'data', 'hybridclaw.db');
  connectorUrl = await listen(connector);
  const modelUrl = await listen(model);
  const port = await getAvailablePort();
  baseUrl = `http://127.0.0.1:${port}`;
  fs.writeFileSync(
    path.join(dataDir, 'config.json'),
    JSON.stringify({
      ops: { healthPort: port },
      // Unroutable so the gateway never calls the hosted HybridAI API.
      hybridai: {
        baseUrl: 'http://127.0.0.1:9',
        defaultModel: 'lmstudio/fake-model',
      },
      local: {
        backends: { lmstudio: { enabled: true, baseUrl: `${modelUrl}/v1` } },
      },
      msteams: {
        enabled: true,
        appId: '00000000-0000-4000-8000-000000000001',
        tenantId: TENANT.toUpperCase(),
        dmPolicy: 'open',
        groupPolicy: 'open',
        requireMention: false,
        personalAgentParent: 'main',
      },
    }),
  );
  const botbuilder = createRequire(path.join(REPO, 'package.json')).resolve(
    'botbuilder',
  );
  const preload = path.join(root, 'teams-auth-off.cjs');
  fs.writeFileSync(
    preload,
    `require(${JSON.stringify(
      createRequire(botbuilder).resolve('botframework-connector'),
    )}).PasswordServiceClientCredentialFactory.prototype.isAuthenticationDisabled = async () => true;\n`,
  );
  gateway = spawn(
    process.execPath,
    ['-r', preload, CLI, 'gateway', 'start', '--foreground', '--sandbox=host'],
    {
      cwd: root,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: home,
        HYBRIDCLAW_DATA_DIR: dataDir,
        HYBRIDCLAW_ACCEPT_TRUST: 'true',
        HYBRIDAI_API_KEY: 'hai-e2e-placeholder',
        MSTEAMS_APP_PASSWORD: 'e2e-app-password',
        WEB_API_TOKEN,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  gateway.stdout?.on('data', (chunk) => {
    gatewayLog += chunk;
  });
  gateway.stderr?.on('data', (chunk) => {
    gatewayLog += chunk;
  });
  await waitForHealth(`${baseUrl}/health`, STARTUP_TIMEOUT_MS);
}

async function stopGateway(): Promise<void> {
  const child = gateway;
  gateway = null;
  if (child && child.exitCode === null) {
    const exited = new Promise<void>((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    await exited;
    clearTimeout(timer);
  }
  await Promise.all(
    servers.map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
}

describe.skipIf(!RUN)('Teams senders in channel_users on a live gateway', () => {
  beforeAll(async () => {
    expect(fs.existsSync(CLI), 'run `npm run build` first').toBe(true);
    try {
      await startGateway();
    } catch (error) {
      console.error('--- gateway log ---\n', gatewayLog);
      throw error;
    }
  }, STARTUP_TIMEOUT_MS + 10_000);

  afterAll(async () => {
    await stopGateway();
    cleanupTrackedTempDirs(tempDirs);
  }, 20_000);

  test(
    'a first DM records the sender once and routes it to an auto-created personal agent',
    async () => {
      await sendMessage('hello');
      await sendMessage('hello again');

      const [personalAgentId, ...rest] = usageAgents();
      expect(personalAgentId).toMatch(/^main-/);
      expect(rest).toEqual([personalAgentId]);
      expect(getMemberCalls).toEqual([ERIKA.teamsId]);
      expect(
        query(
          'SELECT channel_kind, tenant_id, user_id, display_name, email, agent_id, profile_json, message_count FROM channel_users',
        ),
      ).toEqual([
        {
          channel_kind: 'msteams',
          tenant_id: TENANT,
          user_id: ERIKA.aadObjectId,
          display_name: ERIKA.name,
          email: ERIKA.email,
          agent_id: personalAgentId,
          profile_json: JSON.stringify({
            teamsUserId: ERIKA.teamsId,
            entraObjectId: ERIKA.aadObjectId.toLowerCase(),
          }),
          message_count: 2,
        },
      ]);
      expect(sentTexts).toContain('Hello from the fake model.');
    },
    2 * TURN_TIMEOUT_MS,
  );

  test('the admin users payload carries exactly the console row fields', async () => {
    const row = await erikaRow();
    expect(Object.keys(row).sort()).toEqual(CONSOLE_USER_KEYS);
    expect(row).toMatchObject({
      tenantId: TENANT,
      teamsUserId: ERIKA.teamsId,
      entraObjectId: ERIKA.aadObjectId.toLowerCase(),
      displayName: ERIKA.name,
      agentId: usageAgents()[0],
      messageCount: 2,
      sessionCount: 1,
      totalTokens: 300,
    });
    expect(
      (await admin('GET', '/api/admin/msteams/users', undefined, 'wrong-token'))
        .status,
    ).toBe(401);
  });

  test(
    'admin routes reassign the sender and create a personal agent that then answers',
    async () => {
      const assign = (userId: string, agentId: string | null) =>
        admin('PUT', '/api/admin/msteams/users', { userId, agentId });
      expect((await assign('not-a-teams-user', 'main')).status).toBe(404);
      expect((await assign(ERIKA.aadObjectId, 'main')).status).toBe(200);
      await sendMessage('who answers now?');
      expect(usageAgents().at(-1)).toBe('main');

      const created = await admin(
        'POST',
        '/api/admin/msteams/users/personal-agent',
        { userId: ERIKA.aadObjectId, parentAgentId: 'main' },
      );
      expect(created.status).toBe(200);
      const personalAgentId = created.body.agentId as string;
      expect(personalAgentId).not.toBe(usageAgents()[0]);
      expect((await erikaRow()).agentId).toBe(personalAgentId);
      await sendMessage('and now?');
      expect(usageAgents().at(-1)).toBe(personalAgentId);

      expect((await assign(ERIKA.aadObjectId, null)).status).toBe(200);
      expect((await erikaRow()).agentId).toBeNull();
      expect(getMemberCalls).toHaveLength(1);
    },
    3 * TURN_TIMEOUT_MS,
  );
});
