import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { expect, test, vi } from 'vitest';

import { parseSkillManifestFromMarkdown } from '../src/skills/skill-manifest.js';

const helperPath = path.join(process.cwd(), 'skills', 'fronius', 'fronius.cjs');
const skillPath = path.join(process.cwd(), 'skills', 'fronius', 'SKILL.md');
const require = createRequire(import.meta.url);
const fronius = require('../skills/fronius/fronius.cjs');

function runHelper(args: string[]) {
  return spawnSync('node', [helperPath, ...args], {
    encoding: 'utf-8',
  });
}

function request(args: string[]) {
  return fronius.buildRequest(['--format', 'json', 'http-request', ...args]);
}

function withLocalHost<T>(host: string, run: () => T): T {
  const previous = process.env.FRONIUS_LOCAL_HOST;
  process.env.FRONIUS_LOCAL_HOST = host;
  try {
    return run();
  } finally {
    if (previous === undefined) {
      delete process.env.FRONIUS_LOCAL_HOST;
    } else {
      process.env.FRONIUS_LOCAL_HOST = previous;
    }
  }
}

test('Fronius skill manifest declares Solar.web SecretRef metadata only', () => {
  const skill = fs.readFileSync(skillPath, 'utf-8');
  const manifest = parseSkillManifestFromMarkdown(skill, { name: 'fronius' });

  expect(manifest.credentials).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: 'fronius-solarweb-access-key-id',
        secretRef: {
          source: 'store',
          id: 'FRONIUS_SOLARWEB_ACCESS_KEY_ID',
        },
      }),
      expect.objectContaining({
        id: 'fronius-solarweb-access-key-value',
        secretRef: {
          source: 'store',
          id: 'FRONIUS_SOLARWEB_ACCESS_KEY_VALUE',
        },
      }),
    ]),
  );
  expect(manifest.credentials).not.toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: 'fronius-local-host' }),
    ]),
  );
  expect(skill).not.toContain('FRONIUS_SOLARWEB_USER_ID');
  expect(skill).not.toContain('FRONIUS_SOLARWEB_TIMEZONE');
  expect(skill).toContain('category: home-automation');
  expect(skill).toContain('R21.111');
  expect(skill).toContain('Treat the first 401 or 403 live response as final');
  expect(skill).toContain('For 429');
  expect(skill).toContain('api.solarweb.com');
  expect(skill).toContain(
    'the helper is\n  the source of truth for Fronius URLs',
  );
  expect(skill).toContain(
    'Use `local-health` through the helper and `http_request`',
  );
  expect(skill).toContain(
    'Treat the inverter LAN base URL as plain local configuration',
  );
  expect(skill).toContain('rejected or lacks access');
  expect(skill).toContain('export FRONIUS_LOCAL_HOST=');
  expect(skill).not.toContain('secret set FRONIUS_LOCAL_HOST');
  expect(skill).not.toMatch(/\b[Dd]o not\b/);
  expect(skill).not.toMatch(/\b[Dd]on't\b/);
  expect(skill).not.toContain('192.168.1.40');
});

test('Fronius helper --help exits cleanly and lists local and cloud operations', () => {
  const result = runHelper(['--help']);

  expect(result.status).toBe(0);
  expect(result.stdout).toContain('Fronius skill helper');
  expect(result.stdout).toContain('local-health');
  expect(result.stdout).toContain('local-api-version');
  expect(result.stdout).toContain('local-power-flow');
  expect(result.stdout).toContain('local-archive');
  expect(result.stdout).toContain('cloud-auth-check');
  expect(result.stdout).toContain('cloud-pvsystems');
  expect(result.stdout).toContain('cloud-flowdata');
  expect(result.stdout).toContain('cloud-errors');
  expect(result.stdout).not.toContain('--access-key-value');
});

test('Fronius helper covers all local endpoint shapes', () => {
  const cases = [
    ['local-health', '/solar_api/GetAPIVersion.cgi'],
    ['local-api-version', '/solar_api/GetAPIVersion.cgi'],
    ['local-inverter-info', '/solar_api/v1/GetInverterInfo.cgi'],
    [
      'local-inverter-realtime',
      '/solar_api/v1/GetInverterRealtimeData.cgi?Scope=System',
    ],
    ['local-power-flow', '/solar_api/v1/GetPowerFlowRealtimeData.fcgi'],
    [
      'local-meter-realtime',
      '/solar_api/v1/GetMeterRealtimeData.cgi?Scope=System',
    ],
    [
      'local-storage-realtime',
      '/solar_api/v1/GetStorageRealtimeData.cgi?Scope=System',
    ],
    [
      'local-ohmpilot-realtime',
      '/solar_api/v1/GetOhmPilotRealtimeData.cgi?Scope=System',
    ],
    ['local-logger-info', '/solar_api/v1/GetLoggerInfo.cgi'],
    [
      'local-active-device-info',
      '/solar_api/v1/GetActiveDeviceInfo.cgi?DeviceClass=Inverter',
    ],
  ] as const;

  for (const [operation, suffix] of cases) {
    expect(
      request([operation, '--local-host', 'http://192.168.178.40']).httpRequest
        .url,
    ).toBe(`http://192.168.178.40${suffix}`);
  }
});

test('Fronius local API version request uses configured local host', () => {
  const payload = withLocalHost('http://192.168.178.40', () =>
    request(['local-api-version']),
  );

  expect(payload).toMatchObject({
    command: 'http-request',
    operation: 'local-api-version',
    transport: 'local-inverter',
    stakesTier: 'green',
    httpRequest: {
      url: 'http://192.168.178.40/solar_api/GetAPIVersion.cgi',
      method: 'GET',
      skillName: 'fronius',
      timeoutMs: 15000,
      maxResponseBytes: 100000,
    },
  });
});

test('Fronius local realtime request bounds scope and device id', () => {
  const payload = request([
    'local-inverter-realtime',
    '--local-host',
    'http://192.168.1.40',
    '--scope',
    'Device',
    '--device-id',
    '1',
  ]);

  expect(payload.httpRequest.url).toBe(
    'http://192.168.1.40/solar_api/v1/GetInverterRealtimeData.cgi?Scope=Device&DeviceId=1',
  );
});

test('Fronius local request requires plain local host configuration', () => {
  const previous = process.env.FRONIUS_LOCAL_HOST;
  delete process.env.FRONIUS_LOCAL_HOST;
  try {
    const result = runHelper(['http-request', 'local-api-version']);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'Provide --local-host or set FRONIUS_LOCAL_HOST',
    );
  } finally {
    if (previous !== undefined) process.env.FRONIUS_LOCAL_HOST = previous;
  }
});

test('Fronius helper rejects invalid local scope and device id bounds', () => {
  const badScope = runHelper([
    '--local-host',
    'http://192.168.178.40',
    'http-request',
    'local-inverter-realtime',
    '--scope',
    'Plant',
  ]);
  const missingDeviceId = runHelper([
    '--local-host',
    'http://192.168.178.40',
    'http-request',
    'local-inverter-realtime',
    '--scope',
    'Device',
  ]);
  const badDeviceId = runHelper([
    '--local-host',
    'http://192.168.178.40',
    'http-request',
    'local-inverter-realtime',
    '--scope',
    'Device',
    '--device-id',
    '10000',
  ]);

  expect(badScope.status).not.toBe(0);
  expect(badScope.stderr).toContain('--scope must be System or Device');
  expect(missingDeviceId.status).not.toBe(0);
  expect(missingDeviceId.stderr).toContain(
    '--device-id is required for Device scope',
  );
  expect(badDeviceId.status).not.toBe(0);
  expect(badDeviceId.stderr).toContain(
    '--device-id must be an integer between 0 and 9999',
  );
});

test('Fronius local archive request supports repeated channels and emits rollup shape', () => {
  const payload = request([
    'local-archive',
    '--local-host',
    'http://192.168.178.40',
    '--start',
    '2026-05-26',
    '--end',
    '2026-05-27',
    '--channel',
    'EnergyReal_WAC_Sum_Produced',
    '--channel',
    'EnergyReal_WAC_Sum_Consumed',
  ]);

  expect(payload.httpRequest.url).toContain('/solar_api/v1/GetArchiveData.cgi');
  expect(payload.httpRequest.url).toContain('Scope=System');
  expect(payload.httpRequest.url).toContain('StartDate=2026-05-26');
  expect(payload.httpRequest.url).toContain('EndDate=2026-05-27');
  expect(payload.httpRequest.url).toContain(
    'Channel=EnergyReal_WAC_Sum_Produced',
  );
  expect(payload.httpRequest.url).toContain(
    'Channel=EnergyReal_WAC_Sum_Consumed',
  );
  expect(payload.responseShape).toMatchObject({
    kind: 'energy-archive',
    rollup: 'dailyProducedConsumedWh',
  });
});

test('Fronius helper covers all cloud endpoint shapes', () => {
  const cases = [
    [['cloud-auth-check'], 'https://api.solarweb.com/swqapi/pvsystems-list'],
    [['cloud-pvsystems'], 'https://api.solarweb.com/swqapi/pvsystems-list'],
    [
      ['cloud-pvsystem', '--pv-system', 'pv-123'],
      'https://api.solarweb.com/swqapi/pvsystems/pv-123',
    ],
    [
      ['cloud-flowdata', '--pv-system', 'pv-123'],
      'https://api.solarweb.com/swqapi/pvsystems/pv-123/flowdata',
    ],
    [
      [
        'cloud-aggrdata',
        '--pv-system',
        'pv-123',
        '--period',
        'day',
        '--from',
        '2026-05-26',
      ],
      'https://api.solarweb.com/swqapi/pvsystems/pv-123/aggrdata?period=day&from=2026-05-26',
    ],
    [
      [
        'cloud-histdata',
        '--pv-system',
        'pv-123',
        '--from',
        '2026-05-20',
        '--to',
        '2026-05-27',
        '--channel',
        'EnergyReal_WAC_Sum_Produced',
      ],
      'https://api.solarweb.com/swqapi/pvsystems/pv-123/histdata?from=2026-05-20&to=2026-05-27&channel=EnergyReal_WAC_Sum_Produced',
    ],
    [
      ['cloud-messages', '--pv-system', 'pv-123', '--since', '2026-05-20'],
      'https://api.solarweb.com/swqapi/pvsystems/pv-123/messages?since=2026-05-20',
    ],
    [
      ['cloud-devices-list', '--pv-system', 'pv-123'],
      'https://api.solarweb.com/swqapi/pvsystems/pv-123/devices-list',
    ],
    [
      ['cloud-errors', '--pv-system', 'pv-123', '--since', '2026-05-20'],
      'https://api.solarweb.com/swqapi/pvsystems/pv-123/errors?since=2026-05-20',
    ],
  ] as const;

  for (const [args, url] of cases) {
    expect(request([...args]).httpRequest.url).toBe(url);
  }
});

test('Fronius cloud request uses secretHeaders and never cleartext key values', () => {
  const payload = request(['cloud-flowdata', '--pv-system', 'pv-123']);
  const serialized = JSON.stringify(payload);

  expect(payload.httpRequest).toMatchObject({
    url: 'https://api.solarweb.com/swqapi/pvsystems/pv-123/flowdata',
    method: 'GET',
    headers: {
      accept: 'application/json',
    },
    secretHeaders: [
      {
        name: 'AccessKeyId',
        secretName: 'FRONIUS_SOLARWEB_ACCESS_KEY_ID',
        prefix: 'none',
      },
      {
        name: 'AccessKeyValue',
        secretName: 'FRONIUS_SOLARWEB_ACCESS_KEY_VALUE',
        prefix: 'none',
      },
    ],
    skillName: 'fronius',
  });
  expect(payload.responseShape).toMatchObject({
    kind: 'power-flow',
  });
  expect(serialized).not.toContain('FKIA');
  expect(serialized).not.toContain('AccessKeyValue:');
});

test('Fronius cloud aggregate request is shape-stable for energy rollups', () => {
  const payload = request([
    'cloud-aggrdata',
    '--pv-system',
    'pv-123',
    '--period',
    'day',
    '--from',
    '2026-05-26',
  ]);

  expect(payload.httpRequest.url).toBe(
    'https://api.solarweb.com/swqapi/pvsystems/pv-123/aggrdata?period=day&from=2026-05-26',
  );
  expect(payload.responseShape).toMatchObject({
    kind: 'energy-aggregate',
    fields: ['period', 'from', 'to', 'energyProducedWh', 'energyConsumedWh'],
    rollup: 'periodProducedConsumedWh',
  });
});

test('Fronius helper rejects arbitrary endpoint passthrough and secret flags', () => {
  const unsupported = runHelper([
    'http-request',
    '/solar_api/v1/GetLoggerInfo.cgi',
  ]);
  const secretFlag = runHelper([
    'http-request',
    'cloud-pvsystems',
    '--access-key-value',
    'secret',
  ]);
  const equalsSecretFlag = runHelper([
    'http-request',
    'cloud-pvsystems',
    '--access-key-value=leaky-secret',
  ]);
  const unknownFlag = runHelper([
    'http-request',
    'cloud-pvsystems',
    '--unknown-flag',
  ]);

  expect(unsupported.status).not.toBe(0);
  expect(unsupported.stderr).toContain('Unsupported operation');
  expect(secretFlag.status).not.toBe(0);
  expect(secretFlag.stderr).toContain('Store Fronius credentials');
  expect(equalsSecretFlag.status).not.toBe(0);
  expect(equalsSecretFlag.stderr).toContain('Store Fronius credentials');
  expect(equalsSecretFlag.stderr).not.toContain('leaky-secret');
  expect(equalsSecretFlag.stderr).not.toContain('--access-key-value=');
  expect(unknownFlag.status).not.toBe(0);
  expect(unknownFlag.stderr).toContain('Unknown option: --unknown-flag');
  expect(request(['cloud-auth-check']).httpRequest.headers).not.toHaveProperty(
    'Authorization',
  );
});

test('Fronius live gateway result marks auth failures and rate limits', async () => {
  const payload = request(['cloud-flowdata', '--pv-system', 'pv-123']);
  const authFetch = vi.fn(async () => ({
    ok: false,
    status: 200,
    statusText: 'OK',
    text: async () =>
      JSON.stringify({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
        headers: {},
        body: '{"message":"forbidden"}',
      }),
  }));
  const rateFetch = vi.fn(async () => ({
    ok: false,
    status: 200,
    statusText: 'OK',
    text: async () =>
      JSON.stringify({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
        headers: { 'retry-after': '60' },
        body: '{"message":"rate limited"}',
      }),
  }));

  await expect(
    fronius.executeGatewayRequest(payload.httpRequest, {
      gatewayUrl: 'http://127.0.0.1:9090',
      gatewayToken: 'gateway-token',
      fetch: authFetch,
    }),
  ).resolves.toMatchObject({
    status: 403,
    stopAfterFirstAuthFailure: true,
  });
  await expect(
    fronius.executeGatewayRequest(payload.httpRequest, {
      gatewayUrl: 'http://127.0.0.1:9090',
      allowUnauthenticatedGateway: true,
      fetch: rateFetch,
    }),
  ).resolves.toMatchObject({
    status: 429,
    rateLimited: true,
    guidance: 'Solar.web rate limit hit. Retry after 60.',
  });
});
