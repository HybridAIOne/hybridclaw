import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { expect, test } from 'vitest';

import { parseSkillManifestFromMarkdown } from '../src/skills/skill-manifest.js';

const skillRoot = path.join(process.cwd(), 'skills', 'homematic');
const helperPath = path.join(skillRoot, 'homematic.cjs');
const skillPath = path.join(skillRoot, 'SKILL.md');
const fixturePath = path.join(skillRoot, 'fixtures', 'hcu-state.json');
const require = createRequire(import.meta.url);
const homematic = require('../skills/homematic/homematic.cjs');

function runHelper(args: string[]) {
  return spawnSync('node', [helperPath, ...args], {
    encoding: 'utf-8',
  });
}

test('Homematic skill manifest declares HCU credentials and safety metadata', () => {
  const skill = fs.readFileSync(skillPath, 'utf-8');
  const manifest = parseSkillManifestFromMarkdown(skill, { name: 'homematic' });

  expect(manifest.credentials).toEqual([
    {
      id: 'homematic-hcu-auth-token',
      kind: 'bearer',
      required: true,
      secretRef: {
        source: 'store',
        id: 'HOMEMATIC_HCU_AUTH_TOKEN',
      },
      scope: 'Homematic IP HCU Connect API WebSocket authtoken header',
      howToObtain:
        'Enable HCU developer mode, generate an activation key, use\n' +
        '`node skills/homematic/homematic.cjs http-request auth-token` and\n' +
        '`confirm-token`, then store the confirmed Connect API auth token with\n' +
        '`hybridclaw secret set HOMEMATIC_HCU_AUTH_TOKEN "<token>"`.',
    },
    {
      id: 'homematic-hcu-activation-key',
      kind: 'header',
      required: false,
      secretRef: {
        source: 'store',
        id: 'HOMEMATIC_HCU_ACTIVATION_KEY',
      },
      scope: 'One-time HCU Connect API token enrollment',
      howToObtain:
        'Generate an activation key from HCUweb developer mode and store it only\n' +
        'long enough to enroll the Connect API client:\n' +
        '`hybridclaw secret set HOMEMATIC_HCU_ACTIVATION_KEY "<activation-key>"`.',
    },
  ]);
  expect(skill).toContain('category: home-automation');
  expect(skill).toContain('stakes_tiers:');
  expect(skill).toContain('hcu-get-state');
  expect(skill).toContain('safety-alarm-acknowledge');
  expect(skill).toContain('confirm-each');
  expect(skill).toContain('UsageTotals');
  expect(skill).toContain('https://github.com/homematicip/connect-api');
});

test('Homematic helper --help exits cleanly without secret flags', () => {
  const result = runHelper(['--help']);

  expect(result.status).toBe(0);
  expect(result.stdout).toContain('Homematic skill helper');
  expect(result.stdout).toContain('auth-token');
  expect(result.stdout).toContain('websocket-message');
  expect(result.stdout).toContain('set-switch-state');
  expect(result.stdout).toContain('summarize-fixture');
  expect(result.stdout).not.toContain('--auth-token ');
  expect(result.stdout).not.toContain('--activation-key ');
  expect(result.stdout).not.toContain('--password');
});

test('Homematic helper plans explicit reads, ordinary writes, and security writes', () => {
  const read = runHelper(['--format', 'json', 'plan', 'get-state']);
  const thermostat = runHelper([
    '--format',
    'json',
    'plan',
    'set-set-point-temperature',
  ]);
  const alarm = runHelper([
    '--format',
    'json',
    'plan',
    'acknowledge-safety-alarm',
  ]);

  expect(read.status).toBe(0);
  expect(JSON.parse(read.stdout)).toMatchObject({
    operation: 'get-state',
    stakesTier: 'green',
    requiresEscalation: false,
  });
  expect(thermostat.status).toBe(0);
  expect(JSON.parse(thermostat.stdout)).toMatchObject({
    operation: 'set-set-point-temperature',
    stakesTier: 'amber',
    requiredGrant: 'approve-homematic-write',
  });
  expect(alarm.status).toBe(0);
  expect(JSON.parse(alarm.stdout)).toMatchObject({
    operation: 'acknowledge-safety-alarm',
    stakesTier: 'red',
    requiredGrant: 'approve-homematic-security-write',
  });
});

test('Homematic helper emits approval plans with exact approved commands', () => {
  const result = runHelper([
    '--format',
    'json',
    'approval-plan',
    'set-switch-state',
    '--hcu-url',
    'https://hcu1-1234.local',
    '--device-id',
    '3014F711A000000000001234',
    '--channel-index',
    '1',
    '--on',
    'true',
  ]);

  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout);
  expect(payload).toMatchObject({
    command: 'approval-plan',
    operation: 'set-switch-state',
    stakesTier: 'amber',
    requiredGrant: 'approve-homematic-write',
    websocketMessage: {
      operation: 'set-switch-state',
      requiredGrant: 'approve-homematic-write',
    },
  });
  expect(payload.approvedCommand).toContain(
    'node skills/homematic/homematic.cjs --format json websocket-message set-switch-state',
  );
  expect(payload.approvedCommand).toContain(
    '--operator-grant approve-homematic-write',
  );
  expect(payload.approvalText).toContain(
    'Path: /hmip/device/control/setSwitchState',
  );
});

test('Homematic helper builds HCU auth http_request payloads with SecretRef placeholders', () => {
  const auth = runHelper([
    '--format',
    'json',
    '--plugin-id',
    'com.example.hybridclaw.homematic',
    'http-request',
    'auth-token',
    '--hcu-url',
    'https://hcu1-1234.local',
  ]);
  const confirm = runHelper([
    '--format',
    'json',
    'http-request',
    'confirm-token',
    '--hcu-url',
    'https://hcu1-1234.local:6969',
  ]);

  expect(auth.status).toBe(0);
  const authPayload = JSON.parse(auth.stdout);
  expect(authPayload).toMatchObject({
    command: 'http-request',
    operation: 'auth-token',
    stakesTier: 'amber',
  });
  expect(authPayload.httpRequest).toMatchObject({
    method: 'POST',
    url: 'https://hcu1-1234.local:6969/hmip/auth/requestConnectApiAuthToken',
    headers: {
      VERSION: '12',
    },
    json: {
      activationKey: '<secret:HOMEMATIC_HCU_ACTIVATION_KEY>',
      pluginId: 'com.example.hybridclaw.homematic',
    },
    replaceSecretPlaceholders: true,
    skillName: 'homematic',
  });
  expect(JSON.stringify(authPayload)).not.toContain('Authorization');
  expect(JSON.stringify(authPayload)).not.toContain('ABCDEF');

  expect(confirm.status).toBe(0);
  const confirmPayload = JSON.parse(confirm.stdout);
  expect(confirmPayload.httpRequest).toMatchObject({
    url: 'https://hcu1-1234.local:6969/hmip/auth/confirmConnectApiAuthToken',
    json: {
      activationKey: '<secret:HOMEMATIC_HCU_ACTIVATION_KEY>',
      authToken: '<secret:HOMEMATIC_HCU_AUTH_TOKEN>',
    },
  });
});

test('Homematic helper builds read-only HCU websocket messages', () => {
  const payload = homematic.buildRequest([
    '--request-id',
    '38967997-e1b3-463f-8dc4-f889bb5d10a2',
    'websocket-message',
    'get-state',
    '--hcu-url',
    'https://hcu1-1234.local',
  ]);

  expect(payload).toMatchObject({
    command: 'websocket-message',
    operation: 'get-state',
    stakesTier: 'green',
    connection: {
      transport: 'websocket',
      protocol: 'homematic-ip-connect-api',
      url: 'wss://hcu1-1234.local:9001/',
      headers: {
        'plugin-id': 'com.hybridaione.hybridclaw.homematic',
      },
      secretHeaders: [
        {
          name: 'authtoken',
          secretName: 'HOMEMATIC_HCU_AUTH_TOKEN',
          prefix: 'none',
        },
      ],
    },
    message: {
      pluginId: 'com.hybridaione.hybridclaw.homematic',
      id: '38967997-e1b3-463f-8dc4-f889bb5d10a2',
      type: 'HMIP_SYSTEM_REQUEST',
      body: {
        path: '/hmip/home/getState',
        body: {},
      },
    },
    auditEvents: [
      {
        type: 'homematic.state_read_planned',
        skill: 'homematic',
        operation: 'get-state',
        stakesTier: 'green',
        path: '/hmip/home/getState',
        secretRefs: ['HOMEMATIC_HCU_AUTH_TOKEN'],
      },
    ],
  });
  expect(JSON.stringify(payload)).not.toContain('authtoken":"');
});

test('Homematic helper gates and shapes ordinary write websocket messages', () => {
  const payload = homematic.buildRequest([
    '--request-id',
    '38967997-e1b3-463f-8dc4-f889bb5d10a2',
    'websocket-message',
    'set-switch-state',
    '--hcu-url',
    'wss://hcu1-1234.local:9001',
    '--device-id',
    '3014F711A000000000001234',
    '--channel-index',
    '1',
    '--on',
    'true',
    '--operator-grant',
    'approve-homematic-write',
  ]);

  expect(payload).toMatchObject({
    operation: 'set-switch-state',
    stakesTier: 'amber',
    requiredGrant: 'approve-homematic-write',
    message: {
      type: 'HMIP_SYSTEM_REQUEST',
      body: {
        path: '/hmip/device/control/setSwitchState',
        body: {
          deviceId: '3014F711A000000000001234',
          channelIndex: 1,
          on: true,
        },
      },
    },
  });
});

test('Homematic helper gates security writes with a red grant', () => {
  const missingGrant = runHelper([
    '--format',
    'json',
    'websocket-message',
    'acknowledge-safety-alarm',
    '--hcu-url',
    'https://hcu1-1234.local',
    '--operator-grant',
    'approve-homematic-write',
  ]);
  const payload = homematic.buildRequest([
    '--request-id',
    '38967997-e1b3-463f-8dc4-f889bb5d10a2',
    'websocket-message',
    'acknowledge-safety-alarm',
    '--hcu-url',
    'https://hcu1-1234.local',
    '--operator-grant',
    'approve-homematic-security-write',
  ]);

  expect(missingGrant.status).not.toBe(0);
  expect(missingGrant.stderr).toContain(
    'acknowledge-safety-alarm requires --operator-grant approve-homematic-security-write.',
  );
  expect(payload).toMatchObject({
    operation: 'acknowledge-safety-alarm',
    stakesTier: 'red',
    requiredGrant: 'approve-homematic-security-write',
    message: {
      body: {
        path: '/hmip/home/security/acknowledgeSafetyAlarm',
        body: {},
      },
    },
  });
});

test('Homematic helper summarizes HCU state fixtures', () => {
  const result = runHelper([
    '--format',
    'json',
    'summarize-fixture',
    '--fixture',
    fixturePath,
  ]);

  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    command: 'summarize-fixture',
    operation: 'fixture-summary',
    stakesTier: 'green',
    summary: {
      home: {
        label: 'Example Home',
        securityState: 'DISARMED',
      },
      counts: {
        devices: 4,
        groups: 2,
        byType: {
          SWITCH: 1,
          THERMOSTAT: 1,
          SHUTTER: 1,
          SMOKE_ALARM: 1,
        },
      },
    },
  });
  const summary = JSON.parse(result.stdout).summary;
  expect(summary.controllable).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        deviceId: '3014F711A000000000001234',
        feature: 'switchState',
        channelIndex: 1,
      }),
    ]),
  );
  expect(summary.sensitiveSignals).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        friendlyName: 'Smoke Alarm Hallway',
        feature: 'smokeAlarm',
      }),
    ]),
  );
});

test('Homematic helper emits concrete policy rules for HCU network and secret access', () => {
  const payload = homematic.buildRequest([
    'policy-rules',
    '--hcu-url',
    'https://hcu1-1234.local',
    '--agent',
    'main',
  ]);

  expect(payload).toMatchObject({
    command: 'policy-rules',
    operation: 'hcu-policy',
    network: {
      rules: [
        {
          action: 'allow',
          host: 'hcu1-1234.local',
          port: 6969,
          methods: ['POST'],
          paths: [
            '/hmip/auth/requestConnectApiAuthToken',
            '/hmip/auth/confirmConnectApiAuthToken',
          ],
          agent: 'main',
          managed_by_homematic: true,
        },
        {
          action: 'allow',
          host: 'hcu1-1234.local',
          port: 9001,
          methods: ['GET'],
          agent: 'main',
          managed_by_homematic: true,
        },
      ],
    },
    secret: {
      rules: [
        {
          when: {
            predicate: 'secret_resolve_allowed',
            id: 'HOMEMATIC_HCU_AUTH_TOKEN',
            source: 'store',
            sink: 'websocket',
            host: 'hcu1-1234.local',
            selector: 'authtoken',
            agent: 'main',
          },
          action: 'allow',
        },
        {
          when: {
            predicate: 'secret_resolve_allowed',
            id: 'HOMEMATIC_HCU_ACTIVATION_KEY',
            source: 'store',
            sink: 'http',
            host: 'hcu1-1234.local',
            selector: 'json.activationKey',
            agent: 'main',
          },
          action: 'allow',
        },
      ],
    },
  });
});

test('Homematic live WebSocket executor sends one bounded message and summarizes response', async () => {
  class FakeWebSocket extends EventEmitter {
    static instances: FakeWebSocket[] = [];
    sent: string[] = [];
    closed = false;
    url: string;
    options: { headers: Record<string, string> };

    constructor(url: string, options: { headers: Record<string, string> }) {
      super();
      this.url = url;
      this.options = options;
      FakeWebSocket.instances.push(this);
      setImmediate(() => this.emit('open'));
    }

    send(message: string) {
      this.sent.push(message);
      const request = JSON.parse(message);
      setImmediate(() =>
        this.emit(
          'message',
          JSON.stringify({
            id: request.id,
            type: 'HMIP_SYSTEM_RESPONSE',
            body: JSON.parse(fs.readFileSync(fixturePath, 'utf-8')),
          }),
        ),
      );
    }

    close() {
      this.closed = true;
    }
  }
  const request = homematic.buildRequest([
    '--request-id',
    '38967997-e1b3-463f-8dc4-f889bb5d10a2',
    'websocket-message',
    'get-state',
    '--hcu-url',
    'https://hcu1-1234.local',
  ]);

  const result = await homematic.executeHcuWebSocketMessage(request, {
    WebSocketClass: FakeWebSocket,
    authToken: 'test-auth-token',
    timeoutMs: 1000,
  });

  expect(FakeWebSocket.instances).toHaveLength(1);
  expect(FakeWebSocket.instances[0].url).toBe('wss://hcu1-1234.local:9001/');
  expect(FakeWebSocket.instances[0].options.headers).toMatchObject({
    'plugin-id': 'com.hybridaione.hybridclaw.homematic',
    authtoken: 'test-auth-token',
  });
  expect(JSON.parse(FakeWebSocket.instances[0].sent[0])).toMatchObject({
    id: '38967997-e1b3-463f-8dc4-f889bb5d10a2',
    type: 'HMIP_SYSTEM_REQUEST',
    body: {
      path: '/hmip/home/getState',
    },
  });
  expect(FakeWebSocket.instances[0].closed).toBe(true);
  expect(result).toMatchObject({
    command: 'run-websocket',
    operation: 'get-state',
    stakesTier: 'green',
    summary: {
      counts: {
        devices: 4,
      },
    },
    auditEvents: [
      {
        type: 'homematic.state_read_planned',
      },
      {
        type: 'homematic.state_read_completed',
        responseType: 'HMIP_SYSTEM_RESPONSE',
        hasError: false,
      },
    ],
  });
  expect(JSON.stringify(result)).not.toContain('test-auth-token');
});

test('Homematic live WebSocket executor requires token from environment or injection', () => {
  const request = homematic.buildRequest([
    'websocket-message',
    'get-state',
    '--hcu-url',
    'https://hcu1-1234.local',
  ]);

  expect(() =>
    homematic.executeHcuWebSocketMessage(request, {
      WebSocketClass: class {},
      env: {},
      timeoutMs: 10,
    }),
  ).toThrow('HOMEMATIC_HCU_AUTH_TOKEN must be set');
});

test('Homematic helper rejects cleartext secret flags without echoing values', () => {
  const result = runHelper([
    '--format',
    'json',
    'websocket-message',
    'get-state',
    '--hcu-url',
    'https://hcu1-1234.local',
    '--auth-token',
    'secret-token-value',
  ]);

  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain(
    '--auth-token is not supported. Store Homematic credentials in HybridClaw secrets.',
  );
  expect(result.stderr).not.toContain('secret-token-value');
  expect(result.stdout).not.toContain('secret-token-value');
});

test('Homematic helper validates HCU URLs and bounded control values', () => {
  const httpUrl = runHelper([
    '--format',
    'json',
    'websocket-message',
    'get-state',
    '--hcu-url',
    'http://hcu1-1234.local',
  ]);
  const invalidLevel = runHelper([
    '--format',
    'json',
    'websocket-message',
    'set-shutter-level',
    '--hcu-url',
    'https://hcu1-1234.local',
    '--device-id',
    '3014F711A000000000009999',
    '--channel-index',
    '1',
    '--level',
    '1.5',
    '--operator-grant',
    'approve-homematic-write',
  ]);

  expect(httpUrl.status).not.toBe(0);
  expect(httpUrl.stderr).toContain(
    '--hcu-url must use https or wss for HCU WebSocket messages.',
  );
  expect(invalidLevel.status).not.toBe(0);
  expect(invalidLevel.stderr).toContain('--level must be between 0 and 1.');
});
