import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { afterAll, expect, test } from 'vitest';

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
const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { force: true, recursive: true });
  }
});

function runHelper(args: string[]) {
  return spawnSync('node', [helperPath, ...args], {
    encoding: 'utf-8',
  });
}

function writeJsonFixture(payload: unknown) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-alexa-'));
  tempDirs.push(dir);
  const file = path.join(dir, 'request.json');
  fs.writeFileSync(file, JSON.stringify(payload));
  return { dir, file, body: fs.readFileSync(file, 'utf8') };
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

  expect(announce.status).not.toBe(0);
  expect(announce.stderr).toContain('--text must be 4096 bytes or fewer');
  expect(shopping.status).not.toBe(0);
  expect(shopping.stderr).toContain('--item must be 4096 bytes or fewer');
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
