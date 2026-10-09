import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import WebSocket from 'ws';
import {
  dockerBridgeGateway,
  getAvailablePort,
  waitForHealth,
} from './helpers/docker-test-setup.js';
import {
  type FakeHybridAIServer,
  startFakeHybridAIServer,
} from './helpers/fake-hybridai-server.js';
import {
  type FakeTwilioApi,
  startFakeTwilioApi,
  twilioSignature,
} from './helpers/fake-twilio-api.js';
import { cleanupTrackedTempDirs } from './test-utils.js';

// Upgrade-path e2e for the Twilio voice plugin: a 0.39.1-shaped config on the
// compiled gateway (dist/cli.js, host sandbox) with NO install step, and calls
// driven over Twilio's real wire protocols (signed form webhooks,
// ConversationRelay and Media Streams websockets, the REST Calls API). Twilio
// and the HybridAI platform are local fakes; the gateway, config migration,
// plugin loader, agent turn, and realtime bridge are real.
// Gated behind HYBRIDCLAW_RUN_TWILIO_E2E=1; needs `npm run build`. With
// HYBRIDCLAW_TWILIO_E2E_AGENT_IMAGE=<tag>, agent turns run in that container
// image (the default sandbox), where text deltas arrive over stderr and can
// trail the IPC result.
const RUN = process.env.HYBRIDCLAW_RUN_TWILIO_E2E === '1';
const AGENT_IMAGE = process.env.HYBRIDCLAW_TWILIO_E2E_AGENT_IMAGE?.trim() || '';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const CLI = path.join(REPO, 'dist', 'cli.js');
const AUTH_TOKEN = 'test-key';
const WEB_TOKEN = 'test-token';
const BASE = '/api/plugin-webhooks/twilio-voice';
const PUBLIC_BASE = 'https://voice.example.test';
const READY_LOG = 'Twilio voice plugin ready';
const INSTALL_HINT = 'hybridclaw plugin install twilio-voice';
const EMPTY_TWIML =
  '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

const tempDirs: string[] = [];
let root = '';
let gatewayUrl = '';
let gateway: ChildProcess | null = null;
let gatewayLog = '';
let runStart = 0;
let fake: FakeHybridAIServer;
let twilioApi: FakeTwilioApi;

function childEnv(): NodeJS.ProcessEnv {
  const preload = pathToFileURL(path.join(root, 'twilio-fetch.mjs')).href;
  return {
    PATH: process.env.PATH ?? '',
    HOME: path.join(root, 'home'),
    HYBRIDCLAW_DATA_DIR: path.join(root, 'data'),
    HYBRIDAI_API_KEY: 'hai-e2e-placeholder',
    TWILIO_AUTH_TOKEN: AUTH_TOKEN,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import ${preload}`]
      .filter(Boolean)
      .join(' '),
  };
}

// Async on purpose: the fake Twilio API lives in this process, so a blocking
// spawnSync would deadlock a `voice call` waiting on it.
async function runCli(args: string[]): Promise<string> {
  const child = spawn(process.execPath, [CLI, ...args], {
    cwd: root,
    env: childEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
  });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  const status = await new Promise((resolve) => child.once('close', resolve));
  expect(status, output).toBe(0);
  return output;
}

const configFile = () => path.join(root, 'data', 'config.json');
const readConfig = () => JSON.parse(fs.readFileSync(configFile(), 'utf8'));

function editConfig(edit: (config: Record<string, any>) => void): void {
  const config = readConfig();
  edit(config);
  fs.writeFileSync(configFile(), JSON.stringify(config, null, 2));
}

const currentRunLog = () => gatewayLog.slice(runStart);

async function voiceStatus(): Promise<{ pluginLoaded: boolean }> {
  const res = await fetch(`${gatewayUrl}/api/status`, {
    headers: { authorization: `Bearer ${WEB_TOKEN}` },
  });
  return ((await res.json()) as { voice: { pluginLoaded: boolean } }).voice;
}

/** The `voice` flag of the startup "Gateway channels" log line. */
function startupVoiceChannel(): boolean | undefined {
  const line = currentRunLog()
    .split('\n')
    .find((entry) => entry.includes('Gateway channels'));
  const match = line && /"voice":(true|false)/.exec(line);
  return match ? match[1] === 'true' : undefined;
}

async function startGateway(): Promise<void> {
  runStart = gatewayLog.length;
  gateway = spawn(process.execPath, [CLI, 'gateway', 'start', '--foreground'], {
    cwd: root,
    env: childEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  gateway.stdout?.on('data', (chunk) => {
    gatewayLog += chunk;
  });
  gateway.stderr?.on('data', (chunk) => {
    gatewayLog += chunk;
  });
  await waitForHealth(`${gatewayUrl}/health`, 60_000);
}

async function stopGateway(): Promise<void> {
  const child = gateway;
  gateway = null;
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(resolve, 15_000)),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function waitFor<T>(
  probe: () => T | Promise<T>,
  label: string,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/** POSTs a signed Twilio form webhook; raw http so Host can be set. */
function twilioPost(
  pathname: string,
  params: Record<string, string>,
  opts: {
    signedUrl?: string;
    signature?: string;
    idempotency?: string;
    headers?: Record<string, string>;
  } = {},
): Promise<{ status: number; body: string }> {
  const signedUrl = opts.signedUrl ?? `${gatewayUrl}${pathname}`;
  const body = new URLSearchParams(params).toString();
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${gatewayUrl}${pathname}`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'content-length': Buffer.byteLength(body),
          'x-twilio-signature':
            opts.signature ?? twilioSignature(AUTH_TOKEN, signedUrl, params),
          ...(opts.idempotency
            ? { 'i-twilio-idempotency-token': opts.idempotency }
            : {}),
          ...opts.headers,
        },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          text += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

/** Opens the socket TwiML named, the way a proxy maps public to local. */
function twilioSocket(
  publicWsUrl: string,
  opts: { publicBase?: string; headers?: Record<string, string> } = {},
) {
  const publicBase = opts.publicBase ?? gatewayUrl;
  const localUrl = publicWsUrl.replace(
    publicBase.replace(/^http/, 'ws'),
    gatewayUrl.replace(/^http/, 'ws'),
  );
  const ws = new WebSocket(localUrl, {
    headers: {
      'x-twilio-signature': twilioSignature(AUTH_TOKEN, publicWsUrl),
      ...opts.headers,
    },
  });
  return new Promise<WebSocket>((resolve, reject) => {
    ws.once('open', () => resolve(ws));
    ws.once('unexpected-response', (_req, res) =>
      reject(new Error(`upgrade refused: ${res.statusCode}`)),
    );
    ws.once('error', reject);
  });
}

function socketUrlFromTwiml(twiml: string, element: string): string {
  const match = new RegExp(`<${element} url="([^"]+)"`).exec(twiml);
  if (!match) throw new Error(`No <${element}> url in TwiML: ${twiml}`);
  return match[1];
}

function call(callSid: string) {
  return { CallSid: callSid, From: '+15550001111', To: '+14155550123' };
}

/**
 * Sends setup + a final prompt and returns the reply as the caller hears it.
 * Token boundaries are not asserted: in container mode late deltas merge.
 */
async function relayTurn(ws: WebSocket, callSid: string, prompt: string) {
  const tokens: string[] = [];
  const replied = new Promise<void>((resolve) => {
    ws.on('message', (raw) => {
      const frame = JSON.parse(String(raw));
      if (frame.type !== 'text') return;
      tokens.push(frame.token);
      if (frame.last) resolve();
    });
  });
  ws.send(
    JSON.stringify({ type: 'setup', callSid, from: '+15550001111', to: '+14155550123' }),
  );
  ws.send(JSON.stringify({ type: 'prompt', voicePrompt: prompt, last: true }));
  await replied;
  return tokens.join(' ');
}

const AGENT_REPLY = 'Hello from the agent. The weather is sunny today.';

describe.skipIf(!RUN)('twilio-voice plugin on a real gateway', () => {
  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-twilio-e2e-'));
    tempDirs.push(root);
    fs.mkdirSync(path.join(root, 'home'));
    fs.mkdirSync(path.join(root, 'data'));
    const port = await getAvailablePort(
      Number(process.env.HYBRIDCLAW_TWILIO_E2E_PORT) || undefined,
    );
    gatewayUrl = `http://127.0.0.1:${port}`;
    fake = await startFakeHybridAIServer(
      await getAvailablePort(port + 1),
      AGENT_IMAGE ? dockerBridgeGateway() : undefined,
    );
    fake.greetingAudio = Buffer.alloc(800, 0x2a);
    twilioApi = await startFakeTwilioApi({
      port: await getAvailablePort(port + 2),
      authToken: AUTH_TOKEN,
      toReachableUrl: (url) => url.replace(PUBLIC_BASE, gatewayUrl),
    });
    fs.writeFileSync(
      path.join(root, 'twilio-fetch.mjs'),
      twilioApi.fetchRedirectModule,
    );
    // The voice block is what a v0.39.1 install wrote, including the
    // now-retired `webhookPath`; no plugin is installed.
    fs.writeFileSync(
      configFile(),
      JSON.stringify({
        version: 40,
        ops: {
          healthPort: port,
          gatewayBaseUrl: gatewayUrl,
          gatewayInternalBaseUrl: gatewayUrl,
          webApiToken: WEB_TOKEN,
        },
        container: AGENT_IMAGE
          ? // Each call is its own session and keeps its container until the
            // idle timeout, so the default of 5 runs out mid-suite.
            { sandboxMode: 'container', image: AGENT_IMAGE, maxConcurrent: 32 }
          : { sandboxMode: 'host' },
        security: {
          trustModelAccepted: true,
          trustModelAcceptedAt: '2026-10-08T00:00:00Z',
          trustModelVersion: '2026-02-28',
        },
        hybridai: { baseUrl: fake.url, defaultChatbotId: 'bot-e2e' },
        voice: {
          enabled: true,
          provider: 'twilio',
          mode: 'relay',
          twilio: {
            accountSid: 'ACtest0000000000000000000000000000',
            authToken: '',
            fromNumber: '+14155550123',
          },
          relay: {
            ttsProvider: 'default',
            voice: '',
            transcriptionProvider: 'default',
            language: 'en-US',
            interruptible: true,
            welcomeGreeting: 'Hello! How can I help you today?',
          },
          webhookPath: '/voice',
          maxConcurrentCalls: 8,
        },
      }),
    );
    await startGateway();
  }, 90_000);

  afterAll(async () => {
    await stopGateway();
    await fake?.close();
    await twilioApi?.close();
    if (process.env.HYBRIDCLAW_TWILIO_E2E_LOG) {
      fs.writeFileSync(process.env.HYBRIDCLAW_TWILIO_E2E_LOG, gatewayLog);
    }
    cleanupTrackedTempDirs(tempDirs);
  }, 30_000);

  test('a v0.39.1 voice config loads the bundled plugin with no install step', async () => {
    await waitFor(() => currentRunLog().includes(READY_LOG), 'the plugin');
    const config = readConfig();
    expect(config.version).toBeGreaterThanOrEqual(41);
    expect(config.voice.webhookPath).toBeUndefined();
    expect(config.plugins.list).toEqual([
      expect.objectContaining({ id: 'twilio-voice', enabled: true }),
    ]);
    expect(config.plugins.list[0].path).toBeUndefined();
    expect(fs.existsSync(path.join(root, 'home', '.hybridclaw', 'plugins'))).toBe(
      false,
    );
    expect(currentRunLog()).not.toContain(INSTALL_HINT);
    await waitFor(() => startupVoiceChannel() !== undefined, 'the channel log');
    expect(startupVoiceChannel()).toBe(true);
    expect(await voiceStatus()).toMatchObject({ pluginLoaded: true });
  });

  test('the number still pointed at /voice/webhook is answered, signed as Twilio called it', async () => {
    const callSid = `CAlegacy${Date.now()}`;
    expect(
      (
        await twilioPost('/voice/webhook', call(callSid), {
          signedUrl: `${gatewayUrl}${BASE}/webhook`,
        })
      ).status,
    ).toBe(403);
    const answer = await twilioPost('/voice/webhook', call(callSid));
    expect(answer.status).toBe(200);
    const relayUrl = socketUrlFromTwiml(answer.body, 'ConversationRelay');
    expect(relayUrl).toBe(`${gatewayUrl.replace(/^http/, 'ws')}${BASE}/relay`);
    expect(currentRunLog()).toContain('pre-v0.40 /voice/webhook URL');
    for (const pathname of ['/voice/action', '/voice/relay']) {
      expect((await twilioPost(pathname, call(callSid))).status).toBe(404);
    }

    const ws = await twilioSocket(relayUrl);
    expect(await relayTurn(ws, callSid, 'What is the weather today?')).toEqual(
      AGENT_REPLY,
    );
    ws.close();
    expect(
      await twilioPost(`${BASE}/action`, { ...call(callSid), SessionStatus: 'ended' }),
    ).toEqual({ status: 200, body: EMPTY_TWIML });
  }, 120_000);

  test('a relay call streams the agent reply and rejects forged or replayed webhooks', async () => {
    const callSid = `CA${Date.now()}`;
    expect(
      (await twilioPost(`${BASE}/webhook`, call(callSid), { signature: 'x' }))
        .status,
    ).toBe(403);
    const answer = await twilioPost(`${BASE}/webhook`, call(callSid), {
      idempotency: `idem-${callSid}`,
    });
    expect(answer.status).toBe(200);
    expect(
      (
        await twilioPost(`${BASE}/webhook`, call(callSid), {
          idempotency: `idem-${callSid}`,
        })
      ).status,
    ).toBe(409);

    const ws = await twilioSocket(
      socketUrlFromTwiml(answer.body, 'ConversationRelay'),
    );
    expect(await relayTurn(ws, callSid, 'What is the weather today?')).toEqual(
      AGENT_REPLY,
    );
    ws.close();
    expect(fake.chatRequests.at(-1)?.lastUserMessage).toContain(
      'What is the weather today?',
    );
    expect(
      await twilioPost(`${BASE}/action`, { ...call(callSid), SessionStatus: 'ended' }),
    ).toEqual({ status: 200, body: EMPTY_TWIML });
  }, 120_000);

  test('every relay call speaks the whole reply, not just the streamed prefix', async () => {
    for (let index = 0; index < (AGENT_IMAGE ? 12 : 3); index += 1) {
      const callSid = `CAfull${index}x${Date.now()}`;
      const answer = await twilioPost(`${BASE}/webhook`, call(callSid));
      const ws = await twilioSocket(
        socketUrlFromTwiml(answer.body, 'ConversationRelay'),
      );
      expect(await relayTurn(ws, callSid, 'What is the weather today?')).toEqual(
        AGENT_REPLY,
      );
      ws.close();
      await twilioPost(`${BASE}/action`, { ...call(callSid), SessionStatus: 'ended' });
    }
  }, 300_000);

  test('a dropped relay socket is reconnected once from the action callback', async () => {
    const callSid = `CAdrop${Date.now()}`;
    const answer = await twilioPost(`${BASE}/webhook`, call(callSid));
    const relayUrl = socketUrlFromTwiml(answer.body, 'ConversationRelay');
    const first = await twilioSocket(relayUrl);
    first.send(
      JSON.stringify({ type: 'setup', callSid, from: '+15550001111', to: '+14155550123' }),
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    first.terminate();
    const failure = {
      ...call(callSid),
      SessionStatus: 'failed',
      CallStatus: 'in-progress',
      ErrorMessage: 'WebSocket connection closed unexpectedly',
    };

    const reissued = await twilioPost(`${BASE}/action`, failure);
    expect(reissued.status).toBe(200);
    expect(socketUrlFromTwiml(reissued.body, 'ConversationRelay')).toBe(relayUrl);
    const second = await twilioSocket(relayUrl);
    expect(await relayTurn(second, callSid, 'Are you still there?')).toEqual(
      AGENT_REPLY,
    );
    second.terminate();
    expect(await twilioPost(`${BASE}/action`, failure)).toEqual({
      status: 200,
      body: EMPTY_TWIML,
    });
  }, 120_000);

  test('the voice command answers local operators over HTTP and the CLI, and refuses channel users', async () => {
    const command = async (body: Record<string, unknown>) => {
      const res = await fetch(`${gatewayUrl}/api/command`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${WEB_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      return (await res.json()) as { kind: string; title?: string; text: string };
    };

    await expect(
      command({
        sessionId: 'e2e-remote',
        guildId: 'guild-1',
        channelId: 'discord:123',
        args: ['voice', 'call', '+15550001111'],
      }),
    ).resolves.toMatchObject({ kind: 'error', title: 'Command Restricted' });
    expect(twilioApi.calls).toHaveLength(0);
    await expect(
      command({ sessionId: 'e2e-web', channelId: 'web', args: ['voice', 'info'] }),
    ).resolves.toMatchObject({
      text: expect.stringContaining(`${BASE}/webhook`),
    });
    expect(await runCli(['gateway', 'voice', 'info'])).toContain(`${BASE}/webhook`);
  }, 60_000);

  test('A2A local mode hides the Twilio webhooks and sockets from non-loopback hosts', async () => {
    editConfig((config) => {
      config.deployment = { ...config.deployment, a2a_local_mode: true };
    });
    const remote = { host: 'voice.example.test' };
    try {
      const callSid = `CAlocal${Date.now()}`;
      await waitFor(
        async () =>
          (await twilioPost(`${BASE}/webhook`, call(callSid), { headers: remote }))
            .status === 404,
        'the config watcher to apply local mode',
      );
      expect(
        (await twilioPost('/voice/webhook', call(callSid), { headers: remote }))
          .status,
      ).toBe(404);
      await expect(
        twilioSocket(`${gatewayUrl.replace(/^http/, 'ws')}${BASE}/relay`, {
          headers: remote,
        }),
      ).rejects.toThrow('upgrade refused: 404');
      expect((await twilioPost(`${BASE}/webhook`, call(callSid))).status).toBe(
        200,
      );
    } finally {
      editConfig((config) => {
        config.deployment.a2a_local_mode = false;
      });
    }
    await waitFor(
      async () =>
        (
          await twilioPost(`${BASE}/webhook`, call(`CAopen${Date.now()}`), {
            headers: remote,
            signedUrl: `http://voice.example.test${BASE}/webhook`,
          })
        ).status === 200,
      'local mode to switch off',
    );
  }, 60_000);

  test('behind a TLS-terminating tunnel, a private gatewayBaseUrl falls back to the forwarded origin', async () => {
    const tunnel = {
      'x-forwarded-host': 'tunnel.example.test',
      'x-forwarded-proto': 'https',
    };
    const callSid = `CAtunnel${Date.now()}`;
    expect(
      (await twilioPost(`${BASE}/webhook`, call(callSid), { headers: tunnel }))
        .status,
    ).toBe(403);
    const answer = await twilioPost(`${BASE}/webhook`, call(callSid), {
      headers: tunnel,
      signedUrl: `https://tunnel.example.test${BASE}/webhook`,
    });
    expect(answer.status).toBe(200);
    const relayUrl = socketUrlFromTwiml(answer.body, 'ConversationRelay');
    expect(relayUrl).toBe(`wss://tunnel.example.test${BASE}/relay`);
    const ws = await twilioSocket(relayUrl, {
      publicBase: 'https://tunnel.example.test',
      headers: tunnel,
    });
    ws.close();
  }, 60_000);

  test('a plugin reload hangs up a live call and the next call is answered', async () => {
    const callSid = `CAreload${Date.now()}`;
    const answer = await twilioPost(`${BASE}/webhook`, call(callSid));
    const ws = await twilioSocket(
      socketUrlFromTwiml(answer.body, 'ConversationRelay'),
    );
    const frames: Array<Record<string, unknown>> = [];
    ws.on('message', (raw) => frames.push(JSON.parse(String(raw))));
    const closed = new Promise((resolve) => ws.once('close', resolve));
    ws.send(
      JSON.stringify({ type: 'setup', callSid, from: '+15550001111', to: '+14155550123' }),
    );
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(await runCli(['gateway', 'plugin', 'reload'])).toContain(
      'Plugin runtime reloaded.',
    );
    await closed;
    expect(frames).toContainEqual(
      expect.objectContaining({ type: 'end' }),
    );
    expect(
      await twilioPost(`${BASE}/action`, { ...call(callSid), SessionStatus: 'ended' }),
    ).toEqual({ status: 200, body: EMPTY_TWIML });
    const next = await twilioPost(`${BASE}/webhook`, call(`CAafter${Date.now()}`));
    expect(next.status).toBe(200);
    expect(next.body).toContain('<ConversationRelay');
  }, 120_000);

  test('`voice call` places a call through the Calls API and Twilio fetches TwiML back', async () => {
    editConfig((config) => {
      config.ops.gatewayBaseUrl = PUBLIC_BASE;
    });
    await waitFor(
      async () =>
        (await runCli(['gateway', 'voice', 'info'])).includes(
          `${PUBLIC_BASE}${BASE}`,
        ),
      'the public base URL',
    );

    const output = await runCli(['gateway', 'voice', 'call', '+15550002222']);
    expect(output).toContain('Calling +15550002222 from +14155550123');
    expect(twilioApi.calls).toHaveLength(1);
    const placed = twilioApi.calls[0];
    expect(placed).toMatchObject({
      accountSid: 'ACtest0000000000000000000000000000',
      authorized: true,
      params: {
        To: '+15550002222',
        From: '+14155550123',
        Url: `${PUBLIC_BASE}${BASE}/webhook`,
      },
    });
    const webhook = await placed.webhook;
    expect(webhook.status).toBe(200);
    const relayUrl = socketUrlFromTwiml(webhook.body, 'ConversationRelay');
    expect(relayUrl).toBe(`wss://voice.example.test${BASE}/relay`);
    const ws = await twilioSocket(relayUrl, { publicBase: PUBLIC_BASE });
    const callSid = /Call SID: (\w+)/.exec(output)?.[1] ?? '';
    expect(await relayTurn(ws, callSid, 'Hi there')).toEqual(AGENT_REPLY);
    ws.close();
  }, 120_000);

  test('a live switch to realtime mode bridges µ-law audio and agent consults', async () => {
    editConfig((config) => {
      config.voice.mode = 'realtime';
      config.ops.gatewayBaseUrl = PUBLIC_BASE;
    });
    const callSid = `CA${Date.now()}`;
    const answer = await waitFor(async () => {
      const res = await twilioPost(`${BASE}/webhook`, call(callSid), {
        signedUrl: `${PUBLIC_BASE}${BASE}/webhook`,
      });
      return res.body.includes('<Stream') ? res : null;
    }, 'the config watcher to apply realtime mode');
    const streamUrl = socketUrlFromTwiml(answer.body, 'Stream');
    expect(streamUrl).toBe(`wss://voice.example.test${BASE}/stream`);

    const ws = await twilioSocket(streamUrl, { publicBase: PUBLIC_BASE });
    const played: Buffer[] = [];
    ws.on('message', (raw) => {
      const frame = JSON.parse(String(raw));
      if (frame.event === 'media') {
        played.push(Buffer.from(frame.media.payload, 'base64'));
      }
    });
    const streamSid = `MZ${Date.now()}`;
    ws.send(JSON.stringify({ event: 'connected', protocol: 'Call' }));
    ws.send(
      JSON.stringify({
        event: 'start',
        streamSid,
        start: {
          streamSid,
          callSid,
          customParameters: { callReference: callSid },
          mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
        },
      }),
    );
    const callerAudio = Buffer.from(
      Array.from({ length: 160 }, (_, index) => (index * 7) & 0xff),
    );
    for (let frame = 0; frame < 5; frame += 1) {
      ws.send(
        JSON.stringify({
          event: 'media',
          streamSid,
          media: { payload: callerAudio.toString('base64') },
        }),
      );
    }

    await waitFor(
      () => fake.realtime.appendedAudio.length >= 5 && played.length >= 5,
      'audio in both directions',
    );
    expect(
      Buffer.concat(fake.realtime.appendedAudio).equals(
        Buffer.concat(Array(5).fill(callerAudio)),
      ),
    ).toBe(true);
    expect(played.every((frame) => frame.length === 160)).toBe(true);
    expect(Buffer.concat(played).equals(fake.greetingAudio)).toBe(true);
    expect(fake.realtime.sessionUpdates[0]).toMatchObject({
      session: expect.objectContaining({
        audio: expect.objectContaining({
          input: expect.objectContaining({ format: { type: 'audio/pcmu' } }),
        }),
      }),
    });

    fake.triggerConsult('What is the weather today?');
    const output = await waitFor(
      () => fake.realtime.functionOutputs[0],
      'the consulted agent turn',
      90_000,
    );
    expect(output).toContain('The weather is sunny today.');

    ws.send(JSON.stringify({ event: 'stop', streamSid }));
    ws.close();
    expect(
      (
        await twilioPost(
          `${BASE}/action`,
          { ...call(callSid), SessionStatus: 'ended' },
          { signedUrl: `${PUBLIC_BASE}${BASE}/action` },
        )
      ).status,
    ).toBe(200);
  }, 150_000);

  test('after a gateway restart the plugin loads again and answers without a warning', async () => {
    await stopGateway();
    await startGateway();
    await waitFor(() => currentRunLog().includes(READY_LOG), 'the plugin');
    expect(currentRunLog()).not.toContain(INSTALL_HINT);
    const answer = await twilioPost(`${BASE}/webhook`, call(`CArestart${Date.now()}`), {
      signedUrl: `${PUBLIC_BASE}${BASE}/webhook`,
    });
    expect(answer.status).toBe(200);
    expect(answer.body).toContain('<Stream');
  }, 120_000);

  test('a twilio-voice plugin that fails to load is named at startup', async () => {
    await stopGateway();
    const broken = path.join(root, 'broken-twilio-voice');
    fs.mkdirSync(broken, { recursive: true });
    fs.writeFileSync(
      path.join(broken, 'hybridclaw.plugin.yaml'),
      'id: twilio-voice\nname: Broken\nversion: 0.0.1\nkind: channel\nentrypoint: index.js\n',
    );
    fs.writeFileSync(
      path.join(broken, 'index.js'),
      "export default { id: 'twilio-voice', register() { throw new Error('broken on purpose'); } };\n",
    );
    editConfig((config) => {
      config.plugins.list = [
        { id: 'twilio-voice', enabled: true, path: broken, config: {} },
      ];
    });
    await startGateway();

    await waitFor(
      () =>
        currentRunLog().includes('the twilio-voice plugin failed to load') &&
        currentRunLog().includes(INSTALL_HINT),
      'the failed-load warning',
    );
    await waitFor(() => startupVoiceChannel() !== undefined, 'the channel log');
    expect(startupVoiceChannel()).toBe(false);
    expect(await voiceStatus()).toMatchObject({ pluginLoaded: false });
    expect(
      (
        await twilioPost(`${BASE}/webhook`, call(`CAbroken${Date.now()}`), {
          signedUrl: `${PUBLIC_BASE}${BASE}/webhook`,
        })
      ).status,
    ).toBe(404);
  }, 120_000);
});
