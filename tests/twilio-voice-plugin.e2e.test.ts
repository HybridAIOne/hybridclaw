import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import WebSocket from 'ws';
import {
  getAvailablePort,
  waitForHealth,
} from './helpers/docker-test-setup.js';
import {
  type FakeHybridAIServer,
  startFakeHybridAIServer,
} from './helpers/fake-hybridai-server.js';
import { cleanupTrackedTempDirs } from './test-utils.js';

// Upgrade-path e2e for the Twilio voice plugin: a 0.39.1-shaped config on the
// compiled gateway (dist/cli.js, host sandbox), the plugin installed with the
// checkout CLI, and calls driven over Twilio's real wire protocols (signed
// form webhooks, ConversationRelay and Media Streams websockets). Twilio and
// the HybridAI platform (chat completions + realtime) are local fakes; the
// gateway, plugin loader, agent turn, and realtime bridge are real.
// Gated behind HYBRIDCLAW_RUN_TWILIO_E2E=1; needs `npm run build`.
const RUN = process.env.HYBRIDCLAW_RUN_TWILIO_E2E === '1';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const CLI = path.join(REPO, 'dist', 'cli.js');
const PLUGIN_DIR = path.join(REPO, 'plugins', 'twilio-voice');
const AUTH_TOKEN = 'test-key';
const WEB_TOKEN = 'test-token';
const BASE = '/api/plugin-webhooks/twilio-voice';
const PUBLIC_BASE = 'https://voice.example.test';

const tempDirs: string[] = [];
let root = '';
let gatewayUrl = '';
let gateway: ChildProcess | null = null;
let gatewayLog = '';
let fake: FakeHybridAIServer;

function childEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '',
    HOME: path.join(root, 'home'),
    HYBRIDCLAW_DATA_DIR: path.join(root, 'data'),
    HYBRIDAI_API_KEY: 'hai-e2e-placeholder',
    TWILIO_AUTH_TOKEN: AUTH_TOKEN,
    ...(process.env.NODE_OPTIONS
      ? { NODE_OPTIONS: process.env.NODE_OPTIONS }
      : {}),
  };
}

function runCli(args: string[]): string {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: root,
    env: childEnv(),
    encoding: 'utf8',
    timeout: 120_000,
  });
  expect(result.status, result.stderr).toBe(0);
  return `${result.stdout}${result.stderr}`;
}

function editConfig(edit: (config: Record<string, any>) => void): void {
  const file = path.join(root, 'data', 'config.json');
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  edit(config);
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
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

/** Twilio's documented X-Twilio-Signature, independent of the plugin. */
function twilioSignature(url: string, params: Record<string, string> = {}) {
  let payload = url;
  for (const key of Object.keys(params).sort()) payload += key + params[key];
  return createHmac('sha1', AUTH_TOKEN).update(payload).digest('base64');
}

async function twilioPost(
  pathname: string,
  params: Record<string, string>,
  opts: { publicBase?: string; signature?: string; idempotency?: string } = {},
) {
  const signedUrl = `${opts.publicBase ?? gatewayUrl}${pathname}`;
  const res = await fetch(`${gatewayUrl}${pathname}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-twilio-signature':
        opts.signature ?? twilioSignature(signedUrl, params),
      ...(opts.idempotency
        ? { 'i-twilio-idempotency-token': opts.idempotency }
        : {}),
    },
    body: new URLSearchParams(params),
  });
  return { status: res.status, body: await res.text() };
}

/** Opens the socket TwiML named, the way a proxy maps public to local. */
function twilioSocket(publicWsUrl: string, publicBase = gatewayUrl) {
  const localUrl = publicWsUrl.replace(
    publicBase.replace(/^http/, 'ws'),
    gatewayUrl.replace(/^http/, 'ws'),
  );
  const ws = new WebSocket(localUrl, {
    headers: { 'x-twilio-signature': twilioSignature(publicWsUrl) },
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
    fake = await startFakeHybridAIServer(await getAvailablePort(port + 1));
    fake.greetingAudio = Buffer.alloc(800, 0x2a);
    // The voice block is what a v0.39.1 install wrote, including the
    // now-retired `webhookPath`.
    fs.writeFileSync(
      path.join(root, 'data', 'config.json'),
      JSON.stringify({
        version: 40,
        ops: {
          healthPort: port,
          gatewayBaseUrl: gatewayUrl,
          gatewayInternalBaseUrl: gatewayUrl,
          webApiToken: WEB_TOKEN,
        },
        container: { sandboxMode: 'host' },
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
  }, 90_000);

  afterAll(async () => {
    if (gateway && gateway.exitCode === null) {
      const exited = new Promise((resolve) => gateway?.once('exit', resolve));
      gateway.kill('SIGTERM');
      await Promise.race([
        exited,
        new Promise((resolve) => setTimeout(resolve, 15_000)),
      ]);
      if (gateway.exitCode === null) gateway.kill('SIGKILL');
    }
    await fake?.close();
    if (process.env.HYBRIDCLAW_TWILIO_E2E_LOG) {
      fs.writeFileSync(process.env.HYBRIDCLAW_TWILIO_E2E_LOG, gatewayLog);
    }
    cleanupTrackedTempDirs(tempDirs);
  }, 30_000);

  test('a v0.39.1 voice config without the plugin names the install command', async () => {
    await waitFor(
      () => gatewayLog.includes('hybridclaw plugin install twilio-voice'),
      'the install hint',
    );
    for (const pathname of ['/voice/webhook', `${BASE}/webhook`]) {
      expect((await twilioPost(pathname, call('CA-before'))).status).toBe(404);
    }
  });

  test('the checkout CLI installs the plugin and the running gateway loads it', async () => {
    expect(runCli(['plugin', 'install', PLUGIN_DIR])).toContain(
      'Installed plugin twilio-voice',
    );
    expect(runCli(['gateway', 'plugin', 'reload'])).toContain(
      'Plugin runtime reloaded.',
    );
    await waitFor(
      () => gatewayLog.includes('Twilio voice plugin ready'),
      'the plugin to load',
    );
  }, 150_000);

  test('a relay call streams the agent reply over ConversationRelay', async () => {
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
    const tokens: Array<{ token: string; last: boolean }> = [];
    const replied = new Promise<void>((resolve) => {
      ws.on('message', (raw) => {
        const frame = JSON.parse(String(raw));
        if (frame.type !== 'text') return;
        tokens.push({ token: frame.token, last: frame.last });
        if (frame.last) resolve();
      });
    });
    ws.send(
      JSON.stringify({
        type: 'setup',
        callSid,
        from: '+15550001111',
        to: '+14155550123',
      }),
    );
    ws.send(
      JSON.stringify({ type: 'prompt', voicePrompt: 'What is the', last: false }),
    );
    ws.send(
      JSON.stringify({
        type: 'prompt',
        voicePrompt: 'What is the weather today?',
        last: true,
      }),
    );
    await replied;
    ws.close();

    expect(tokens).toEqual([
      { token: 'Hello from the agent.', last: false },
      { token: 'The weather is sunny today.', last: true },
    ]);
    expect(fake.chatRequests.at(-1)?.lastUserMessage).toContain(
      'What is the weather today?',
    );
    const ended = await twilioPost(`${BASE}/action`, {
      ...call(callSid),
      SessionStatus: 'ended',
    });
    expect(ended).toEqual({
      status: 200,
      body: '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
    });
  }, 120_000);

  test('the voice command answers local operators and refuses channel users', async () => {
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
    await expect(
      command({ sessionId: 'e2e-web', channelId: 'web', args: ['voice', 'info'] }),
    ).resolves.toMatchObject({
      text: expect.stringContaining(`${BASE}/webhook`),
    });
  });

  test('a live switch to realtime mode bridges µ-law audio and agent consults', async () => {
    editConfig((config) => {
      config.voice.mode = 'realtime';
      config.ops.gatewayBaseUrl = PUBLIC_BASE;
    });
    const callSid = `CA${Date.now()}`;
    const answer = await waitFor(async () => {
      const res = await twilioPost(`${BASE}/webhook`, call(callSid), {
        publicBase: PUBLIC_BASE,
      });
      return res.body.includes('<Stream') ? res : null;
    }, 'the config watcher to apply realtime mode');
    const streamUrl = socketUrlFromTwiml(answer.body, 'Stream');
    expect(streamUrl).toBe(`wss://voice.example.test${BASE}/stream`);

    const ws = await twilioSocket(streamUrl, PUBLIC_BASE);
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
          { publicBase: PUBLIC_BASE },
        )
      ).status,
    ).toBe(200);
  }, 150_000);
});
