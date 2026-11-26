import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  getAvailablePort,
  waitForHealth,
} from './helpers/docker-test-setup.js';
import { cleanupTrackedTempDirs } from './test-utils.js';

// The compiled gateway has no bot credentials. One local server plays the
// platform it is signed in to: the Teams relay (Bot Connector REST under a
// relay path) and the model. Nothing in the Teams SDK is stubbed. Requires
// HYBRIDCLAW_RUN_MSTEAMS_E2E=1 and a build.
const RUN = process.env.HYBRIDCLAW_RUN_MSTEAMS_E2E === '1';
const REPO = fileURLToPath(new URL('..', import.meta.url));
const CLI = path.join(REPO, 'dist', 'cli.js');
const WEB_API_TOKEN = 'e2e-teams-relay-token';
const PLATFORM_KEY = 'hai-relay-e2e-key';
const RELAY_PATH = '/api/hybridclaw/msteams/app-1';
const CONVERSATION = 'a:1personal-erika';
const STARTUP_TIMEOUT_MS = 45_000;
const TURN_TIMEOUT_MS = 30_000;
// A 1x1 PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

interface ConnectorCall {
  method: string;
  url: string;
  authorization: string;
  text?: string;
}

const tempDirs: string[] = [];
const servers: http.Server[] = [];
const connectorCalls: ConnectorCall[] = [];
let gateway: ChildProcess | null = null;
let gatewayLog = '';
let baseUrl = '';
let platformUrl = '';
let strangerUrl = '';
let strangerCalls = 0;
const refusedCalls: string[] = [];
let dataDir = '';

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function listen(
  handler: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: string,
  ) => void,
): Promise<string> {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => handler(req, res, body));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function platform(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  body: string,
): void {
  const url = req.url ?? '';
  if (url.startsWith(`${RELAY_PATH}/v3/`)) {
    // The relay carries only what a turn needs, below a conversation.
    const allowedMethod = /\/attachments\/|\/members\//.test(url)
      ? req.method === 'GET'
      : ['POST', 'PUT', 'DELETE'].includes(req.method ?? '');
    if (
      !allowedMethod ||
      !/\/v3\/conversations\/[^/?]+\/(activities(\/[^/?]+)?|members\/[^/?]+|attachments\/[^/?]+\/views\/[^/?]+)$/.test(
        url,
      )
    ) {
      refusedCalls.push(`${req.method} ${url}`);
      return json(res, 403, {});
    }
    connectorCalls.push({
      method: req.method ?? '',
      url,
      authorization: String(req.headers.authorization ?? ''),
      text: (JSON.parse(body || '{}') as { text?: string }).text,
    });
    if (/\/attachments\//.test(url)) {
      // A file Teams serves only to the bot, fetched by the relay for the gateway.
      if (req.headers.authorization !== `Bearer ${PLATFORM_KEY}`) {
        return json(res, 401, {});
      }
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end(PNG);
    }
    if (/\/members\//.test(url)) {
      return json(res, 200, {
        id: '29:1erika-teams-id',
        name: 'Erika Example',
        email: 'erika@example.com',
      });
    }
    return json(res, 200, { id: `bot-activity-${connectorCalls.length}` });
  }
  if (req.method === 'GET' && url.endsWith('/models')) {
    return json(res, 200, { object: 'list', data: [{ id: 'fake-model' }] });
  }
  if (req.method === 'POST' && url.endsWith('/chat/completions')) {
    const content = 'Hello from the fake model.';
    if (!(JSON.parse(body) as { stream?: boolean }).stream) {
      return json(res, 200, {
        id: 'c1',
        object: 'chat.completion',
        model: 'fake-model',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const chunk of [
      { choices: [{ index: 0, delta: { role: 'assistant', content } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    ]) {
      res.write(
        `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', model: 'fake-model', ...chunk })}\n\n`,
      );
    }
    return res.end('data: [DONE]\n\n');
  }
  json(res, 404, {});
}

let activitySeq = 0;
async function relay(
  serviceUrl: string,
  token: string | null = WEB_API_TOKEN,
  conversationId = CONVERSATION,
  extra: Record<string, unknown> = {},
): Promise<number> {
  activitySeq += 1;
  const response = await fetch(`${baseUrl}/api/msteams/relay`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      type: 'message',
      text: 'Hello?',
      textFormat: 'plain',
      id: `user-activity-${activitySeq}`,
      timestamp: new Date().toISOString(),
      serviceUrl,
      channelId: 'msteams',
      from: {
        id: '29:1erika-teams-id',
        name: 'Erika Example',
        aadObjectId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
      },
      recipient: { id: '28:relayed-bot', name: 'Bot' },
      conversation: { id: conversationId, conversationType: 'personal' },
      channelData: { tenant: { id: '72f988bf-86f1-41af-91ab-2d7cd011db47' } },
      ...extra,
    }),
  });
  return response.status;
}

describe.runIf(RUN)('Teams through a relay that owns the bot', () => {
  beforeAll(async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-teams-relay-e2e-'));
    tempDirs.push(root);
    const home = path.join(root, 'home');
    dataDir = path.join(root, 'data');
    fs.mkdirSync(home);
    fs.mkdirSync(dataDir);
    platformUrl = await listen(platform);
    strangerUrl = await listen((_req, res) => {
      strangerCalls += 1;
      json(res, 200, {});
    });
    const port = await getAvailablePort();
    baseUrl = `http://127.0.0.1:${port}`;
    fs.writeFileSync(
      path.join(dataDir, 'config.json'),
      JSON.stringify({
        ops: { healthPort: port },
        hybridai: {
          baseUrl: platformUrl,
          defaultModel: 'lmstudio/fake-model',
        },
        local: {
          backends: {
            lmstudio: { enabled: true, baseUrl: `${platformUrl}/v1` },
          },
        },
        // No appId, no tenant, and no MSTEAMS_APP_PASSWORD anywhere.
        msteams: { enabled: true, dmPolicy: 'open' },
      }),
    );
    gateway = spawn(
      process.execPath,
      [CLI, 'gateway', 'start', '--foreground', '--sandbox=host'],
      {
        cwd: root,
        env: {
          PATH: process.env.PATH ?? '',
          HOME: home,
          HYBRIDCLAW_DATA_DIR: dataDir,
          HYBRIDCLAW_ACCEPT_TRUST: 'true',
          HYBRIDAI_API_KEY: PLATFORM_KEY,
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
  }, STARTUP_TIMEOUT_MS + 15_000);

  afterAll(async () => {
    const child = gateway;
    gateway = null;
    if (child && child.exitCode === null) {
      const exited = new Promise<void>((resolve) =>
        child.once('exit', resolve),
      );
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
      await exited;
      clearTimeout(timer);
    }
    for (const server of servers) server.close();
    cleanupTrackedTempDirs(tempDirs);
  });

  test(
    'a relayed activity is acknowledged at once and answered through the relay with the platform credential',
    async () => {
      // The route sits behind the gateway's own API authentication.
      expect(await relay(`${platformUrl}${RELAY_PATH}/`, null)).toBe(401);
      // The platform credential only ever goes to the platform.
      expect(await relay(`${strangerUrl}/`)).toBe(400);
      expect(await relay(`${platformUrl}${RELAY_PATH}/`, WEB_API_TOKEN, 'a/../x')).toBe(
        400,
      );
      // Only the relay's own surface of the platform counts as the relay.
      for (const elsewhere of [
        `${platformUrl}/v1/`,
        `${platformUrl}${RELAY_PATH}/../../../v1/`,
        `${platformUrl}${RELAY_PATH}/?x=1`,
      ]) {
        expect(await relay(elsewhere), elsewhere).toBe(400);
      }
      for (const id of ['..', 'x/y', 'x?y']) {
        expect(
          await relay(`${platformUrl}${RELAY_PATH}/`, WEB_API_TOKEN, CONVERSATION, {
            replyToId: id,
          }),
          id,
        ).toBe(400);
      }

      expect(await relay(`${platformUrl}${RELAY_PATH}/`)).toBe(202);
      await expect
        .poll(
          () => connectorCalls.find((call) => call.text?.includes('fake model')),
          { timeout: TURN_TIMEOUT_MS, message: gatewayLog.slice(-4000) },
        )
        .toBeDefined();

      const reply = connectorCalls.find((call) =>
        call.text?.includes('fake model'),
      );
      expect(reply?.method).toBe('POST');
      expect(reply?.url).toContain(
        `${RELAY_PATH}/v3/conversations/${CONVERSATION}/activities`,
      );
      expect(new Set(connectorCalls.map((call) => call.authorization))).toEqual(
        new Set([`Bearer ${PLATFORM_KEY}`]),
      );
      expect(strangerCalls).toBe(0);

      // A pasted image arrives as a link below the relay, and is fetched there
      // with the platform credential.
      const image = `${RELAY_PATH}/v3/conversations/${CONVERSATION}/attachments/att-1/views/original`;
      expect(
        await relay(`${platformUrl}${RELAY_PATH}/`, WEB_API_TOKEN, CONVERSATION, {
          attachments: [
            { contentType: 'image/png', contentUrl: `${platformUrl}${image}` },
          ],
        }),
      ).toBe(202);
      await expect
        .poll(() => connectorCalls.find((call) => call.url === image), {
          timeout: TURN_TIMEOUT_MS,
          message: gatewayLog.slice(-4000),
        })
        .toMatchObject({ method: 'GET', authorization: `Bearer ${PLATFORM_KEY}` });

      // Once the turn is over, a later message for this chat uses the stored
      // reply address, which is still the relay.
      await expect
        .poll(
          () => connectorCalls.filter((call) => call.text?.includes('fake model')),
          { timeout: TURN_TIMEOUT_MS },
        )
        .toHaveLength(2);
      const db = new Database(path.join(dataDir, 'data', 'hybridclaw.db'), {
        readonly: true,
      });
      const session = db
        .prepare(
          "SELECT id FROM sessions WHERE session_key LIKE '%msteams%' ORDER BY created_at DESC LIMIT 1",
        )
        .get() as { id: string };
      db.close();
      const sent = await fetch(`${baseUrl}/api/message/action`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${WEB_API_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          action: 'send',
          sessionId: session.id,
          channelId: 'msteams:current',
          content: 'Your report is ready.',
        }),
      });
      expect(sent.status, await sent.clone().text()).toBe(200);
      const later = connectorCalls.find(
        (call) => call.text === 'Your report is ready.',
      );
      expect(later).toMatchObject({
        method: 'POST',
        authorization: `Bearer ${PLATFORM_KEY}`,
      });
      expect(later?.url).toContain(
        `${RELAY_PATH}/v3/conversations/${CONVERSATION}/activities`,
      );
      expect(strangerCalls).toBe(0);
      expect(refusedCalls).toEqual([]);
    },
    3 * TURN_TIMEOUT_MS + 15_000,
  );
});
