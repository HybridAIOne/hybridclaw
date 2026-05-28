import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, expect, test, vi } from 'vitest';

import { parseSkillManifestFromMarkdown } from '../src/skills/skill-manifest.js';

const helperPath = path.join(process.cwd(), 'skills', 'alexa', 'alexa.cjs');
const skillPath = path.join(process.cwd(), 'skills', 'alexa', 'SKILL.md');
const signingCertPath = path.join(
  process.cwd(),
  'tests',
  'fixtures',
  'alexa-signing-cert.pem',
);
const signingKeyPath = path.join(
  process.cwd(),
  'tests',
  'fixtures',
  'alexa-signing-key.pem',
);
const require = createRequire(import.meta.url);
const alexa = require('../skills/alexa/alexa.cjs');
const alexaAuth = require('../skills/alexa/alexa-auth.cjs');
const authHelperPath = path.join(
  process.cwd(),
  'skills',
  'alexa',
  'alexa-auth.cjs',
);
const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { force: true, recursive: true });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

function runHelper(args: string[]) {
  return spawnSync('node', [helperPath, ...args], {
    encoding: 'utf-8',
  });
}

function runAuthHelper(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync('node', [authHelperPath, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, ...env },
  });
}

function writeJsonFixture(payload: unknown) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-alexa-'));
  tempDirs.push(dir);
  const file = path.join(dir, 'request.json');
  fs.writeFileSync(file, JSON.stringify(payload));
  return { dir, file, body: fs.readFileSync(file, 'utf8') };
}

function writeExecutable(name: string, source: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-alexa-bin-'));
  tempDirs.push(dir);
  const file = path.join(dir, name);
  fs.writeFileSync(file, source);
  fs.chmodSync(file, 0o755);
  return file;
}

function buildAskRequest(timestamp: string) {
  return {
    version: '1.0',
    session: {
      new: true,
      sessionId: 'SessionId.test',
      application: { applicationId: 'amzn1.ask.skill.test' },
      user: { userId: 'amzn1.ask.account.test' },
    },
    context: {
      System: {
        application: { applicationId: 'amzn1.ask.skill.test' },
        user: { accessToken: 'opaque-lwa-token' },
      },
    },
    request: {
      type: 'IntentRequest',
      requestId: 'EdwRequestId.test',
      timestamp,
      locale: 'en-US',
      intent: {
        name: 'AskHybridClawIntent',
        confirmationStatus: 'NONE',
        slots: {
          Question: {
            name: 'Question',
            value: 'turn on the kitchen lights',
            confirmationStatus: 'NONE',
          },
        },
      },
    },
  };
}

function createAlexaSigningFixture(body: string) {
  const privateKey = fs.readFileSync(signingKeyPath, 'utf8');
  const signature = crypto
    .createSign('RSA-SHA1')
    .update(body, 'utf8')
    .sign(privateKey, 'base64');
  return { certPath: signingCertPath, signature };
}

test('Alexa skill manifest declares SecretRef credentials and safety metadata', () => {
  const skill = fs.readFileSync(skillPath, 'utf-8');
  const manifest = parseSkillManifestFromMarkdown(skill, { name: 'alexa' });

  expect(manifest.credentials).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: 'alexa-ask-skill-id',
        kind: 'header',
        required: true,
        secretRef: { source: 'store', id: 'ALEXA_ASK_SKILL_ID' },
      }),
      expect.objectContaining({
        id: 'alexa-lwa-client-secret',
        kind: 'oauth',
        required: true,
        secretRef: { source: 'store', id: 'ALEXA_LWA_CLIENT_SECRET' },
      }),
      expect.objectContaining({
        id: 'alexa-smarthome-refresh-token',
        kind: 'oauth',
        required: false,
        secretRef: { source: 'store', id: 'ALEXA_SMARTHOME_REFRESH_TOKEN' },
      }),
      expect.objectContaining({
        id: 'alexa-refresh-cookie',
        kind: 'header',
        required: false,
        secretRef: { source: 'store', id: 'ALEXA_REFRESH_COOKIE' },
      }),
    ]),
  );
  expect(skill).toContain('name: alexa');
  expect(skill).toContain('category: home-automation');
  expect(skill).toContain('ALEXA_ASK_SKILL_ID');
  expect(skill).toContain('ALEXA_LWA_CLIENT_SECRET');
  expect(skill).toContain('ALEXA_SMARTHOME_REFRESH_TOKEN');
  expect(skill).toContain('ALEXA_REFRESH_COOKIE');
  expect(skill).toContain(
    '/alexa set up Echo control for amazon.de and store the cookie',
  );
  expect(skill).toContain('/skill alexa list my Alexa devices for amazon.de');
  expect(skill).toContain('node skills/alexa/alexa-auth.cjs setup');
  expect(skill).toContain('--detach --timeout-ms 600000');
  expect(skill).toContain(
    'Never print a\nproxy URL that did not come from the current helper output.',
  );
  expect(skill).toContain('node skills/alexa/alexa-auth.cjs status');
  expect(skill).toContain('ad hoc shell process management');
  expect(skill).toContain('alexa-auth.cjs import-cookie');
  expect(skill).toContain('full Cookie header');
  expect(skill).toContain('A single cookie value such as');
  expect(skill).not.toContain('alexacli');
  expect(skill).toContain('stakes_tiers:');
  expect(skill).toContain('event: alexa.relink_required');
  expect(skill).toContain('UsageTotals');
});

test('Alexa helper --help exits cleanly', () => {
  const result = runHelper(['--help']);

  expect(result.status).toBe(0);
  expect(result.stdout).toContain('Alexa skill helper');
  expect(result.stdout).toContain('verify-request');
  expect(result.stdout).toContain('parse-request');
  expect(result.stdout).toContain('build-response');
  expect(result.stdout).toContain('smarthome-control');
  expect(result.stdout).toContain('shopping-list-add');
});

test('Alexa auth helper --help documents HybridClaw-owned browser setup', () => {
  const result = runAuthHelper(['--help']);

  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('Alexa Remote authentication helper');
  expect(result.stdout).toContain(
    'node skills/alexa/alexa-auth.cjs setup --domain amazon.de --write-secret',
  );
  expect(result.stdout).toContain('--detach');
  expect(result.stdout).toContain('status --domain amazon.de');
  expect(result.stdout).toContain('Defaults to 600000.');
  expect(result.stdout).toContain('captures the resulting refresh token');
  expect(result.stdout).not.toContain('alexa-cookie-cli');
  expect(result.stdout).not.toContain('alexacli');
});

test('Alexa auth helper status reports missing detached setup safely', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-alexa-auth-'));
  tempDirs.push(dir);
  const statusFile = path.join(dir, 'missing-status.json');
  const result = runAuthHelper([
    '--format',
    'json',
    'status',
    '--domain',
    'amazon.de',
    '--status-file',
    statusFile,
  ]);

  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    command: 'status',
    domain: 'amazon.de',
    exists: false,
    state: 'missing',
    statusFile,
  });
});

test('Alexa auth helper status reports a live detached setup process', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-alexa-auth-'));
  tempDirs.push(dir);
  const statusFile = path.join(dir, 'live-status.json');
  fs.writeFileSync(
    statusFile,
    JSON.stringify({
      command: 'setup',
      domain: 'amazon.de',
      pid: process.pid,
      port: 50102,
      proxyUrl: 'http://127.0.0.1:50102/',
      state: 'listening',
    }),
  );

  const result = runAuthHelper([
    '--format',
    'json',
    'status',
    '--domain',
    'amazon.de',
    '--status-file',
    statusFile,
  ]);

  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    command: 'status',
    domain: 'amazon.de',
    exists: true,
    processAlive: true,
    state: 'listening',
    proxyUrl: 'http://127.0.0.1:50102/',
  });
});

test('Alexa auth helper normalizes browser cookies and device API payloads', () => {
  expect(alexaAuth.alexaDevicesApiUrl('amazon.de')).toBe(
    'https://alexa.amazon.de/api/devices-v2/device?cached=false',
  );
  expect(alexaAuth.authBaseDomain('amazon.de')).toBe('amazon.com');
  expect(alexaAuth.authBaseDomain('amazon.co.jp')).toBe('amazon.co.jp');
  expect(alexaAuth.alexaRuntimeBaseUrl('amazon.de')).toBe(
    'https://layla.amazon.com',
  );
  expect(alexaAuth.localeFlags('amazon.de')).toEqual([
    '-a',
    'de_DE',
    '-L',
    'de-DE',
  ]);
  const cookieHeader = alexaAuth.buildCookieHeader([
    { name: 'session-id', value: 'abc123' },
    { name: 'csrf', value: 'csrf-token' },
    { name: '', value: 'ignored' },
  ]);
  expect(cookieHeader).toBe('session-id=abc123; csrf=csrf-token');
  expect(alexaAuth.csrfFromCookieHeader(cookieHeader)).toBe('csrf-token');
  expect(
    alexaAuth.normalizeDevices({
      devices: [
        {
          accountName: 'OK Computer',
          serialNumber: 'G090LF09647500TV',
          deviceType: 'A3S5BH2HU6VAYF',
          deviceOwnerCustomerId: 'A1EXAMPLECUSTOMER',
          deviceFamily: 'ECHO',
          online: true,
        },
      ],
    }),
  ).toEqual([
    {
      accountName: 'OK Computer',
      serialNumber: 'G090LF09647500TV',
      deviceType: 'A3S5BH2HU6VAYF',
      deviceOwnerCustomerId: 'A1EXAMPLECUSTOMER',
      deviceFamily: 'ECHO',
      online: true,
    },
  ]);
});

test('Alexa auth helper builds cookies from Amazon refresh-token exchange payloads', () => {
  const cookieHeader = alexaAuth.cookieHeaderFromExchange({
    response: {
      tokens: {
        cookies: {
          '.amazon.de': [
            { Name: 'session-id', Value: 'abc123' },
            { Name: 'ubid-main', Value: 'customer-region' },
          ],
          '.alexa.amazon.de': [{ Name: 'csrf', Value: 'csrf-token' }],
        },
      },
    },
  });

  expect(cookieHeader).toBe(
    'session-id=abc123; ubid-main=customer-region; csrf=csrf-token',
  );
});

test('Alexa auth helper verifies browser cookies against requested marketplace first', async () => {
  const fetchMock = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (url) => {
      const href = String(url);
      if (
        href ===
        'https://alexa.amazon.de/api/devices-v2/device?cached=false'
      ) {
        return new Response(
          JSON.stringify({
            devices: [
              {
                accountName: 'OK Computer',
                serialNumber: 'G090LF09647500TV',
                deviceType: 'A3S5BH2HU6VAYF',
                deviceOwnerCustomerId: 'A1EXAMPLECUSTOMER',
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (
        href ===
        'https://layla.amazon.com/api/devices-v2/device?cached=true'
      ) {
        return new Response('', { status: 500 });
      }
      if (
        href ===
        'https://pitangui.amazon.com/api/devices-v2/device?cached=true'
      ) {
        return new Response('', { status: 500 });
      }
      throw new Error(`Unexpected fetch: ${href}`);
    });

  const auth = await alexaAuth.verifyCookieHeaderWithFallbacks(
    'session-id=abc123; csrf=csrf-token',
    'amazon.de',
    ['amazon.de', 'amazon.com'],
    'csrf-token',
  );

  expect(auth.runtimeBaseUrl).toBe('https://layla.amazon.com');
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0]?.[0]).toBe(
    'https://alexa.amazon.de/api/devices-v2/device?cached=false',
  );
});

test('Alexa auth helper exchanges refresh tokens on auth domain and verifies local marketplace', async () => {
  const fetchMock = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (url, init) => {
      const href = String(url);
      if (href === 'https://api.amazon.com/ap/exchangetoken/cookies') {
        expect(String(init?.body)).toContain('domain=.amazon.com');
        expect(init?.headers).toMatchObject({
          'x-amzn-identity-auth-domain': 'api.amazon.com',
        });
        return new Response(
          JSON.stringify({
            response: {
              tokens: {
                cookies: {
                  '.amazon.com': [{ Name: 'session-id', Value: 'abc123' }],
                  '.alexa.amazon.com': [
                    { Name: 'csrf', Value: 'csrf-token' },
                  ],
                },
              },
            },
          }),
          { status: 200 },
        );
      }
      if (
        href ===
        'https://alexa.amazon.de/api/devices-v2/device?cached=false'
      ) {
        return new Response(
          JSON.stringify({
            devices: [
              {
                accountName: 'OK Computer',
                serialNumber: 'G090LF09647500TV',
                deviceType: 'A3S5BH2HU6VAYF',
                deviceOwnerCustomerId: 'A1EXAMPLECUSTOMER',
              },
            ],
          }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected fetch: ${href}`);
    });

  const auth = await alexaAuth.exchangeRefreshToken(
    'Atnr|test-token',
    'amazon.com',
    'amazon.de',
  );

  expect(auth.runtimeBaseUrl).toBe('https://layla.amazon.com');
  expect(auth.cookieHeader).toContain('session-id=abc123');
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test('Alexa auth helper imports a recognized cookie header without printing secret values', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-alexa-auth-'));
  tempDirs.push(dir);
  const config = path.join(dir, 'config.json');
  fs.writeFileSync(
    config,
    JSON.stringify({
      auth: {
        cookieHeader:
          'session-id=abc123; csrf=csrf-token; ubid-main=customer-region',
      },
    }),
  );
  const fakeHybridClaw = writeExecutable(
    'hybridclaw',
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'secret' && args[1] === 'set' && args[2] === 'ALEXA_REFRESH_COOKIE') {
  console.log('Stored encrypted secret ALEXA_REFRESH_COOKIE.');
  process.exit(0);
}
console.error('unexpected args: ' + args.slice(0, 3).join(' '));
process.exit(1);
`,
  );

  const result = runAuthHelper(
    [
      '--format',
      'json',
      'import-cookie',
      '--config',
      config,
      '--write-secret',
      '--skip-verify',
    ],
    { HYBRIDCLAW_BIN: fakeHybridClaw },
  );

  expect(result.status, result.stderr).toBe(0);
  const payload = JSON.parse(result.stdout);
  expect(payload).toMatchObject({
    command: 'import-cookie',
    secretName: 'ALEXA_REFRESH_COOKIE',
    discovered: true,
    wroteSecret: true,
  });
  expect(payload.cookie.cookieNames).toEqual([
    'session-id',
    'csrf',
    'ubid-main',
  ]);
  expect(result.stdout).not.toContain('abc123');
  expect(result.stdout).not.toContain('csrf-token');
});

test('Alexa auth helper infers amazon.de from copied Safari cURL imports', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-alexa-auth-'));
  tempDirs.push(dir);
  const config = path.join(dir, 'safari-curl.txt');
  fs.writeFileSync(
    config,
    [
      "curl 'https://alexa.amazon.de/api/devices-v2/device?cached=false'",
      "-H 'Cookie: session-id=abc123; csrf=csrf-token; at-acbde=access-token; ubid-acbde=region'",
    ].join(' \\\n'),
  );
  const fakeHybridClaw = writeExecutable(
    'hybridclaw',
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'secret' && args[1] === 'set' && args[2] === 'ALEXA_REFRESH_COOKIE') {
  console.log('Stored encrypted secret ALEXA_REFRESH_COOKIE.');
  process.exit(0);
}
console.error('unexpected args: ' + args.slice(0, 3).join(' '));
process.exit(1);
`,
  );

  const result = runAuthHelper(
    [
      '--format',
      'json',
      'import-cookie',
      '--config',
      config,
      '--write-secret',
      '--skip-verify',
    ],
    { HYBRIDCLAW_BIN: fakeHybridClaw },
  );

  expect(result.status, result.stderr).toBe(0);
  const payload = JSON.parse(result.stdout);
  expect(payload).toMatchObject({
    command: 'import-cookie',
    domain: 'amazon.de',
    runtimeBaseUrl: 'https://layla.amazon.com',
    wroteSecret: true,
  });
  expect(payload.cookie.cookieNames).toEqual([
    'session-id',
    'csrf',
    'at-acbde',
    'ubid-acbde',
  ]);
  expect(result.stdout).not.toContain('abc123');
  expect(result.stdout).not.toContain('csrf-token');
  expect(result.stdout).not.toContain('access-token');
});

test('Alexa response builder strips unsafe markdown and long URLs from SSML', () => {
  const payload = alexa.buildResponse([
    '--speech',
    'Done. ```js\nsecret()\n``` See **report** https://example.com/this/path/is/far/too/long/for/alexa/to/read/out/loud',
    '--reprompt',
    'Need _anything_ else?',
    '--card-title',
    'HybridClaw',
  ]);

  expect(payload.response.outputSpeech.ssml).toContain('<speak>');
  expect(payload.response.outputSpeech.ssml).toContain('report');
  expect(payload.response.outputSpeech.ssml).toContain('[link omitted]');
  expect(payload.response.outputSpeech.ssml).not.toContain('```');
  expect(payload.response.outputSpeech.ssml).not.toContain('secret()');
  expect(payload.response.reprompt.outputSpeech.ssml).toContain('anything');
});

test('Alexa parser maps ASK intent slots to a bounded agent bridge', () => {
  const { file } = writeJsonFixture(
    buildAskRequest('2026-05-27T12:00:00.000Z'),
  );
  const payload = alexa.parseRequest({ requestBody: file });

  expect(payload.request).toMatchObject({
    type: 'IntentRequest',
    intentName: 'AskHybridClawIntent',
    applicationId: 'amzn1.ask.skill.test',
  });
  expect(payload.session.linkedAccountTokenPresent).toBe(true);
  expect(payload.agentBridge).toMatchObject({
    action: 'agent-question',
    stakesTier: 'green',
    asyncAllowed: true,
    args: {
      Question: 'turn on the kitchen lights',
    },
  });
});

test('Alexa account-link session exchange keeps LWA token material out of output', () => {
  const { file } = writeJsonFixture(
    buildAskRequest('2026-05-27T12:00:00.000Z'),
  );
  const result = runHelper([
    '--format',
    'json',
    'account-link-session',
    '--request-body',
    file,
  ]);

  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout);
  expect(payload).toMatchObject({
    command: 'account-link-session',
    linkedAccountTokenPresent: true,
    tokenVisibleToModel: false,
    persistLwaToken: false,
  });
  expect(payload.sessionExchange).toMatchObject({
    source: 'context.System.user.accessToken',
    exchange: 'hybridclaw-operator-session',
    secretRail: 'F13 SecretRef',
  });
  expect(payload.auditEvents).toBeUndefined();
  expect(JSON.stringify(payload)).not.toContain('opaque-lwa-token');
});

test('Alexa ASK validation checks cert URL, timestamp, certificate SAN, and signature', () => {
  const timestamp = new Date(Date.now() + 5_000).toISOString();
  const { file, body } = writeJsonFixture(buildAskRequest(timestamp));
  const { certPath, signature } = createAlexaSigningFixture(body);

  const result = runHelper([
    '--format',
    'json',
    '--request-body',
    file,
    '--signature-cert-url',
    'https://s3.amazonaws.com/echo.api/test-cert.pem',
    '--signature',
    signature,
    '--cert-pem',
    certPath,
    '--now',
    timestamp,
    '--expected-skill-id',
    'amzn1.ask.skill.test',
    'verify-request',
  ]);

  expect(result.status, result.stderr).toBe(0);
  const payload = JSON.parse(result.stdout);
  expect(payload.valid).toBe(true);
  expect(payload.checks).toMatchObject({
    certUrl: 'pass',
    certificateSan: 'echo-api.amazon.com',
    signature: 'pass',
    applicationId: 'pass',
  });
  expect(payload.checks.timestamp.status).toBe('pass');
});

test('Alexa ASK validation rejects stale timestamps and non-ASK certificate URLs', () => {
  const stale = writeJsonFixture(buildAskRequest('2026-05-27T12:00:00.000Z'));
  const staleResult = runHelper([
    '--format',
    'json',
    '--request-body',
    stale.file,
    '--signature-cert-url',
    'https://s3.amazonaws.com/echo.api/test-cert.pem',
    '--signature',
    'bad',
    '--now',
    '2026-05-27T12:04:00.000Z',
    'verify-request',
  ]);

  expect(staleResult.status).not.toBe(0);
  expect(staleResult.stderr).toContain('timestamp drift');

  const fresh = writeJsonFixture(buildAskRequest('2026-05-27T12:00:00.000Z'));
  const badUrlResult = runHelper([
    '--format',
    'json',
    '--request-body',
    fresh.file,
    '--signature-cert-url',
    'https://example.com/echo.api/test-cert.pem',
    '--signature',
    'bad',
    '--now',
    '2026-05-27T12:00:05.000Z',
    'verify-request',
  ]);

  expect(badUrlResult.status).not.toBe(0);
  expect(badUrlResult.stderr).toContain('host must be s3.amazonaws.com');

  const malformedPathResult = runHelper([
    '--format',
    'json',
    '--request-body',
    fresh.file,
    '--signature-cert-url',
    'https://s3.amazonaws.com/echo.api/%E0%A4%A',
    '--signature',
    'bad',
    '--now',
    '2026-05-27T12:00:05.000Z',
    'verify-request',
  ]);

  expect(malformedPathResult.status).not.toBe(0);
  expect(malformedPathResult.stderr).toContain('valid percent-encoding');
});

test('Alexa Smart Home plans emit directive-compatible payloads with F8/F14 approvals', () => {
  const turnOn = runHelper([
    '--format',
    'json',
    'plan',
    'smarthome-control',
    '--endpoint-id',
    'light-kitchen',
    '--action',
    'TurnOn',
  ]);
  const thermostat = runHelper([
    '--format',
    'json',
    'plan',
    'smarthome-control',
    '--endpoint-id',
    'thermostat-hallway',
    '--action',
    'SetTargetTemperature',
    '--temperature',
    '20.5',
  ]);

  expect(turnOn.status).toBe(0);
  const turnOnPayload = JSON.parse(turnOn.stdout);
  expect(turnOnPayload.directive.header).toMatchObject({
    namespace: 'Alexa.PowerController',
    name: 'TurnOn',
    payloadVersion: '3',
  });
  expect(turnOnPayload.httpRequestTemplate).toMatchObject({
    method: 'POST',
    url: 'https://api.amazonalexa.com/v3/events',
    bearerSecretName: 'ALEXA_SMARTHOME_ACCESS_TOKEN',
  });
  expect(turnOnPayload.httpRequest).toBeUndefined();
  expect(turnOnPayload.directive.endpoint).toMatchObject({
    endpointId: 'light-kitchen',
  });
  expect(turnOnPayload.requiredApproval).toMatchObject({
    framework: 'F8/F14',
    stakesTier: 'amber',
    requiredGrant: 'approve-alexa-write',
  });
  expect(turnOnPayload.requiredApproval.approvalText).toContain(
    'Target: light-kitchen',
  );
  expect(turnOnPayload.requiredApproval.approvalText).toContain(
    'Action: TurnOn',
  );

  const regional = runHelper([
    '--format',
    'json',
    'plan',
    'smarthome-control',
    '--endpoint-id',
    'light-kitchen',
    '--action',
    'TurnOn',
    '--region-host',
    'api.eu.amazonalexa.com',
  ]);
  expect(regional.status).toBe(0);
  const regionalPayload = JSON.parse(regional.stdout);
  expect(regionalPayload.approvedCommand).toEqual(
    expect.arrayContaining(['--region-host', 'api.eu.amazonalexa.com']),
  );
  expect(regionalPayload.requiredApproval.approvalText).toContain(
    'api.eu.amazonalexa.com',
  );

  expect(thermostat.status).toBe(0);
  const thermostatPayload = JSON.parse(thermostat.stdout);
  expect(thermostatPayload.requiredApproval).toMatchObject({
    stakesTier: 'red',
    requiredGrant: 'approve-alexa-red-write',
  });
  expect(thermostatPayload.directive.payload.targetSetpoint).toMatchObject({
    value: 20.5,
    scale: 'CELSIUS',
  });

  const color = runHelper([
    '--format',
    'json',
    'plan',
    'smarthome-control',
    '--endpoint-id',
    'light-kitchen',
    '--action',
    'SetColor',
    '--color',
    '{"hue":120,"saturation":0.5,"brightness":0.75}',
  ]);
  expect(color.status).toBe(0);
  const colorPayload = JSON.parse(color.stdout);
  expect(colorPayload.directive.payload.color).toEqual({
    hue: 120,
    saturation: 0.5,
    brightness: 0.75,
  });
});

test('Alexa Smart Home controls reject unstructured color values', () => {
  const result = runHelper([
    '--format',
    'json',
    'plan',
    'smarthome-control',
    '--endpoint-id',
    'light-kitchen',
    '--action',
    'SetColor',
    '--color',
    'red',
  ]);

  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('--color must be JSON');
});

test('Alexa write http-request commands require exact operator grants', () => {
  const missingGrant = runHelper([
    '--format',
    'json',
    'http-request',
    'smarthome-control',
    '--endpoint-id',
    'light-kitchen',
    '--action',
    'TurnOn',
  ]);
  const wrongGrant = runHelper([
    '--format',
    'json',
    'http-request',
    'smarthome-control',
    '--endpoint-id',
    'thermostat-hallway',
    '--action',
    'SetTargetTemperature',
    '--temperature',
    '20.5',
    '--operator-grant',
    'approve-alexa-write',
  ]);
  const granted = runHelper([
    '--format',
    'json',
    'http-request',
    'announce',
    '--device',
    'living-room',
    '--text',
    'Package delivered.',
    '--operator-grant',
    'approve-alexa-write',
  ]);
  const complete = runHelper([
    '--format',
    'json',
    'http-request',
    'shopping-list-complete',
    '--item-id',
    'item-1',
    '--operator-grant',
    'approve-alexa-write',
  ]);
  const playback = runHelper([
    '--format',
    'json',
    'http-request',
    'music-play',
    '--device',
    'G090LF09647500TV',
    '--device-name',
    'OK Computer',
    '--device-type',
    'A3S5BH2HU6VAYF',
    '--customer-id',
    'A1EXAMPLECUSTOMER',
    '--query',
    'Münchner Freiheit',
  ]);
  const voiceCommand = runHelper([
    '--format',
    'json',
    'http-request',
    'voice-command',
    '--device',
    'G090LF09647500TV',
    '--device-name',
    'OK Computer',
    '--device-type',
    'A3S5BH2HU6VAYF',
    '--customer-id',
    'A1EXAMPLECUSTOMER',
    '--voice-command',
    'play Münchner Freiheit',
    '--operator-grant',
    'approve-alexa-write',
  ]);

  expect(missingGrant.status).not.toBe(0);
  expect(missingGrant.stderr).toContain(
    'smarthome-control requires --operator-grant approve-alexa-write',
  );
  expect(wrongGrant.status).not.toBe(0);
  expect(wrongGrant.stderr).toContain(
    'smarthome-control requires --operator-grant approve-alexa-red-write',
  );
  expect(granted.status).toBe(0);
  const payload = JSON.parse(granted.stdout);
  expect(payload.httpRequest).toMatchObject({
    method: 'POST',
    url: 'https://alexa.amazon.com/api/behaviors/preview',
    cookieSecretName: 'ALEXA_REFRESH_COOKIE',
  });
  expect(payload.requiredApproval).toBeUndefined();

  expect(complete.status).toBe(0);
  const completePayload = JSON.parse(complete.stdout);
  expect(completePayload.httpRequest).toMatchObject({
    method: 'PUT',
    url: 'https://alexa.amazon.com/api/namedLists/shopping/items/item-1',
    cookieSecretName: 'ALEXA_REFRESH_COOKIE',
    bodyJson: { completed: true },
  });

  expect(playback.status).not.toBe(0);
  expect(playback.stderr).toContain(
    'music-play requires --operator-grant approve-alexa-write',
  );
  expect(voiceCommand.status).not.toBe(0);
  expect(voiceCommand.stderr).toContain(
    'voice-command requires --operator-grant approve-alexa-red-write',
  );
});

test('Alexa helper emits bounded community requests and relink events without secret output', () => {
  const read = runHelper([
    '--format',
    'json',
    'http-request',
    'devices',
    '--amazon-domain',
    'amazon.de',
  ]);
  const announce = runHelper([
    '--format',
    'json',
    'plan',
    'announce',
    '--device',
    'living-room',
    '--text',
    'Package delivered.',
    '--amazon-domain',
    'amazon.de',
  ]);

  expect(read.status).toBe(0);
  const readPayload = JSON.parse(read.stdout);
  expect(readPayload.httpRequest).toMatchObject({
    method: 'GET',
    url: 'https://alexa.amazon.de/api/devices-v2/device',
    cookieSecretName: 'ALEXA_REFRESH_COOKIE',
  });
  expect(readPayload.authFailureEvent).toMatchObject({
    event: 'alexa.relink_required',
    surface: 'community',
  });
  expect(JSON.stringify(readPayload)).not.toContain('password');
  expect(JSON.stringify(readPayload)).not.toContain('refresh cookie');

  expect(announce.status).toBe(0);
  const announcePayload = JSON.parse(announce.stdout);
  expect(announcePayload.httpRequestTemplate).toMatchObject({
    method: 'POST',
    url: 'https://alexa.amazon.de/api/behaviors/preview',
    cookieSecretName: 'ALEXA_REFRESH_COOKIE',
  });
  expect(announcePayload.httpRequest).toBeUndefined();
  expect(announcePayload.requiredApproval.approvalText).toContain(
    'Target: living-room',
  );
  expect(announcePayload.requiredApproval.approvalText).toContain(
    'Package delivered.',
  );
  expect(announcePayload.stopOnStatuses).toEqual([401, 403]);
});

test('Alexa helper plans guarded Echo music playback from resolved device ids', () => {
  const result = runHelper([
    '--format',
    'json',
    'plan',
    'music-play',
    '--device',
    'G090LF09647500TV',
    '--device-name',
    'OK Computer',
    '--device-type',
    'A3S5BH2HU6VAYF',
    '--customer-id',
    'A1EXAMPLECUSTOMER',
    '--query',
    'Münchner Freiheit',
    '--provider',
    'AMAZON_MUSIC',
    '--amazon-domain',
    'amazon.de',
  ]);

  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout);
  expect(payload.requiredApproval).toMatchObject({
    framework: 'F8/F14',
    stakesTier: 'amber',
    requiredGrant: 'approve-alexa-write',
  });
  expect(payload.requiredApproval.approvalText).toContain(
    'Target: OK Computer',
  );
  expect(payload.requiredApproval.approvalText).toContain(
    'play "Münchner Freiheit" via AMAZON_MUSIC',
  );
  expect(payload.approvedCommand).toEqual(
    expect.arrayContaining([
      '--device',
      'G090LF09647500TV',
      '--device-name',
      'OK Computer',
      '--device-type',
      'A3S5BH2HU6VAYF',
      '--customer-id',
      'A1EXAMPLECUSTOMER',
      '--query',
      'Münchner Freiheit',
      '--provider',
      'AMAZON_MUSIC',
      '--amazon-domain',
      'amazon.de',
    ]),
  );
  expect(payload.httpRequestTemplate).toMatchObject({
    method: 'POST',
    url: 'https://alexa.amazon.de/api/behaviors/preview',
    cookieSecretName: 'ALEXA_REFRESH_COOKIE',
  });
  const sequence = JSON.parse(payload.httpRequestTemplate.bodyJson.sequenceJson);
  expect(sequence.startNode).toMatchObject({
    '@type': 'com.amazon.alexa.behaviors.model.ParallelNode',
  });
  expect(sequence.startNode.nodesToExecute[0]).toMatchObject({
    type: 'Alexa.Music.PlaySearchPhrase',
    operationPayload: {
      deviceSerialNumber: 'G090LF09647500TV',
      deviceType: 'A3S5BH2HU6VAYF',
      customerId: 'A1EXAMPLECUSTOMER',
      locale: 'de-DE',
      musicProviderId: 'AMAZON_MUSIC',
      searchPhrase: 'Münchner Freiheit',
      sanitizedSearchPhrase: 'Münchner Freiheit',
    },
  });
});

test('Alexa helper plans red-gated Echo voice commands as a guarded fallback', () => {
  const result = runHelper([
    '--format',
    'json',
    'plan',
    'voice-command',
    '--device',
    'G090LF09647500TV',
    '--device-name',
    'OK Computer',
    '--device-type',
    'A3S5BH2HU6VAYF',
    '--customer-id',
    'A1EXAMPLECUSTOMER',
    '--voice-command',
    'play Münchner Freiheit',
    '--amazon-domain',
    'amazon.de',
  ]);

  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout);
  expect(payload.requiredApproval).toMatchObject({
    framework: 'F8/F14',
    stakesTier: 'red',
    requiredGrant: 'approve-alexa-red-write',
  });
  expect(payload.requiredApproval.approvalText).toContain(
    'send "play Münchner Freiheit" to Alexa',
  );
  expect(payload.approvedCommand).toEqual(
    expect.arrayContaining([
      '--device',
      'G090LF09647500TV',
      '--device-name',
      'OK Computer',
      '--device-type',
      'A3S5BH2HU6VAYF',
      '--customer-id',
      'A1EXAMPLECUSTOMER',
      '--voice-command',
      'play Münchner Freiheit',
      '--amazon-domain',
      'amazon.de',
      '--operator-grant',
      'approve-alexa-red-write',
    ]),
  );
  expect(payload.httpRequestTemplate).toMatchObject({
    method: 'POST',
    url: 'https://alexa.amazon.de/api/behaviors/preview',
    cookieSecretName: 'ALEXA_REFRESH_COOKIE',
  });
  const sequence = JSON.parse(payload.httpRequestTemplate.bodyJson.sequenceJson);
  expect(sequence.startNode).toMatchObject({
    type: 'Alexa.TextCommand',
    operationPayload: {
      deviceSerialNumber: 'G090LF09647500TV',
      deviceType: 'A3S5BH2HU6VAYF',
      customerId: 'A1EXAMPLECUSTOMER',
      locale: 'de-DE',
      skillId: 'amzn1.ask.1p.tellalexa',
      text: 'play Münchner Freiheit',
    },
  });
});

test('Alexa helper fails fast on overlong text and item inputs', () => {
  const overlong = 'x'.repeat(4097);
  const announce = runHelper([
    '--format',
    'json',
    'plan',
    'announce',
    '--device',
    'living-room',
    '--text',
    overlong,
  ]);
  const shopping = runHelper([
    '--format',
    'json',
    'plan',
    'shopping-list-add',
    '--item',
    overlong,
  ]);
  const playback = runHelper([
    '--format',
    'json',
    'plan',
    'music-play',
    '--device',
    'G090LF09647500TV',
    '--device-type',
    'A3S5BH2HU6VAYF',
    '--customer-id',
    'A1EXAMPLECUSTOMER',
    '--query',
    overlong,
  ]);
  const voiceCommand = runHelper([
    '--format',
    'json',
    'plan',
    'voice-command',
    '--device',
    'G090LF09647500TV',
    '--device-type',
    'A3S5BH2HU6VAYF',
    '--customer-id',
    'A1EXAMPLECUSTOMER',
    '--voice-command',
    overlong,
  ]);

  expect(announce.status).not.toBe(0);
  expect(announce.stderr).toContain('--text must be 4096 bytes or fewer');
  expect(shopping.status).not.toBe(0);
  expect(shopping.stderr).toContain('--item must be 4096 bytes or fewer');
  expect(playback.status).not.toBe(0);
  expect(playback.stderr).toContain('--query must be 4096 bytes or fewer');
  expect(voiceCommand.status).not.toBe(0);
  expect(voiceCommand.stderr).toContain(
    '--voice-command must be 4096 bytes or fewer',
  );
});

test('Alexa Smart Home discovery emits relink handling on authorization failures', () => {
  const result = runHelper([
    '--format',
    'json',
    'http-request',
    'smarthome-discover',
  ]);

  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout);
  expect(payload.authFailureEvent).toMatchObject({
    event: 'alexa.relink_required',
    surface: 'smart-home',
    target: 'discovery',
  });
  expect(payload.stopOnStatuses).toEqual([401, 403]);
  expect(payload.stopOnErrorTypes).toEqual([
    'INVALID_AUTHORIZATION_CREDENTIAL',
  ]);
});

test('Alexa helper rejects arbitrary endpoint passthrough and secret CLI flags', () => {
  const arbitrary = runHelper([
    '--format',
    'json',
    'http-request',
    'https://example.com/anything',
  ]);
  const secret = runHelper([
    '--format',
    'json',
    'http-request',
    'devices',
    '--password',
    'not-allowed',
  ]);

  expect(arbitrary.status).not.toBe(0);
  expect(arbitrary.stderr).toContain('Unsupported http-request command');
  expect(secret.status).not.toBe(0);
  expect(secret.stderr).toContain(
    'Store Alexa credentials in HybridClaw secrets',
  );
});

test('Alexa response builder accepts only explicit true or false booleans', () => {
  const result = runHelper([
    '--format',
    'json',
    'build-response',
    '--speech',
    'Done.',
    '--should-end-session',
    'yes',
  ]);

  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('--should-end-session must be true or false');
});
