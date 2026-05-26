import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { expect, test } from 'vitest';

import { parseSkillManifestFromMarkdown } from '../src/skills/skill-manifest.js';

const helperPath = path.join(process.cwd(), 'skills', 'shelly', 'shelly.cjs');
const skillPath = path.join(process.cwd(), 'skills', 'shelly', 'SKILL.md');
const require = createRequire(import.meta.url);
const shelly = require('../skills/shelly/shelly.cjs');

function runHelper(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync('node', [helperPath, ...args], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      ...env,
    },
  });
}

function request(args: string[]) {
  return shelly.buildRequest(['--format', 'json', ...args]);
}

function approvalPlan(args: string[]) {
  return shelly.buildRequest(['--format', 'json', 'approval-plan', ...args]);
}

test('Shelly skill manifest declares optional cloud credential and guarded operations', () => {
  const skill = fs.readFileSync(skillPath, 'utf-8');
  const manifest = parseSkillManifestFromMarkdown(skill, { name: 'shelly' });

  expect(skill).toContain('Shelly Gen2 RPC methods');
  expect(skill).toContain('Cover.GetConfig');
  expect(manifest.credentials).toEqual([
    {
      id: 'shelly-cloud-auth-key',
      kind: 'api_key',
      required: false,
      secretRef: {
        source: 'store',
        id: 'SHELLY_CLOUD_AUTH_KEY',
      },
      scope: 'Shelly Cloud Control API tenant host auth_key query parameter',
      howToObtain:
        'Generate an Authorization cloud key in Shelly Smart Control user settings and store it with `hybridclaw secret set SHELLY_CLOUD_AUTH_KEY "<key>"`.',
    },
    {
      id: 'shelly-cloud-access-token',
      kind: 'bearer',
      required: false,
      secretRef: {
        source: 'store',
        id: 'SHELLY_CLOUD_ACCESS_TOKEN',
      },
      scope: 'Shelly Cloud Real Time Events HTTP API Authorization bearer',
      howToObtain:
        'Use Shelly\'s documented OAuth flow for the Real Time Events API and store the resulting access token with `hybridclaw secret set SHELLY_CLOUD_ACCESS_TOKEN "<access-token>"`.',
    },
  ]);
  expect(skill).toContain('category: home-automation');
  expect(skill).toContain('Keep the markdown instructions generic');
  expect(skill).toContain(
    'API-specific request\nconstruction belongs in `shelly.cjs`.',
  );
  expect(skill).toContain('cover.status');
  expect(skill).toContain('cover.goto');
  expect(skill).toContain('switch.set');
  expect(skill).toContain('gen1.get');
  expect(skill).toContain('rpc.call');
  expect(skill).toContain('cloud.websocket-url');
  expect(skill).toContain(
    'Pass the helper-emitted `httpRequest` object unchanged',
  );
  expect(skill).toContain('approval-plan');
  expect(skill).toContain('approvedHelperCommandText');
  expect(skill).toContain('light.set');
  expect(skill).toContain('factory-reset');
  expect(skill).toContain('Required Inputs');
  expect(skill).toContain('Shelly Cloud tenant server URI');
  expect(skill).toContain('Authorization Cloud Key');
  expect(skill).toContain('Device Information');
  expect(skill).toContain('SHELLY_OAUTH_CODE');
  expect(skill).toContain('OAuth JWT `user_api_url`');
  expect(skill).toContain('Discovery and Names');
  expect(skill).toContain('Cloud Control API v2 requires known device ids');
  expect(skill).toContain('Real Time Events all-status can discover');
  expect(skill).toContain('OAuth/Bearer authorization');
  expect(skill).toContain('cloud oauth-token');
  expect(skill).toContain('cloud all-status');
  expect(skill).toContain('WebSocket helpers emit');
  expect(skill).toContain('Access to Local Devices');
  expect(skill).toContain(
    'local TUI/web `/policy` command, or the `/admin/approvals` network policy',
  );
  expect(skill).toContain('helper-emitted host,\nport, method, and path.');
  expect(skill).toContain('Shelly names can exist in multiple layers');
  expect(skill).toContain('Report the field\n  and API surface');
  expect(skill).toContain('Result Handling');
  expect(skill).toContain(
    'Base status and control answers on successful live Shelly API results',
  );
  expect(skill).not.toContain('session_search');
  expect(skill).not.toContain('Response Formatting');
  expect(skill).not.toContain('SSRF');
  expect(skill).not.toContain('Wrong parameteres provided');
});

test('Shelly helper --help exits cleanly and lists local and cloud operations', () => {
  const result = runHelper(['--help']);

  expect(result.status).toBe(0);
  expect(result.stdout).toContain('Shelly skill helper');
  expect(result.stdout).toContain('approval-plan <resource> <action>');
  expect(result.stdout).toContain('device status');
  expect(result.stdout).toContain('cover config');
  expect(result.stdout).toContain('cover open');
  expect(result.stdout).toContain('cover goto');
  expect(result.stdout).toContain('relay set');
  expect(result.stdout).toContain('cloud state');
  expect(result.stdout).toContain('cloud oauth-token');
  expect(result.stdout).toContain('cloud all-status');
  expect(result.stdout).toContain('switch set');
  expect(result.stdout).toContain('gen1 get');
  expect(result.stdout).toContain('gen1 set');
  expect(result.stdout).toContain('rpc get');
  expect(result.stdout).toContain('rpc call');
  expect(result.stdout).toContain('cloud websocket-url');
  expect(result.stdout).toContain('cloud websocket-command');
});

test('Shelly helper builds local Gen2 RPC read requests', () => {
  const status = request([
    'device',
    'status',
    '--device-url',
    'http://192.0.2.10',
  ]);
  const components = request([
    'device',
    'components',
    '--device-url',
    '192.0.2.10',
    '--include',
    'status',
    '--include',
    'config',
    '--key',
    'switch:0',
  ]);
  const coverConfig = request([
    'cover',
    'config',
    '--device-url',
    '192.0.2.10',
    '--id',
    '0',
  ]);
  const coverStatus = request([
    'cover',
    'status',
    '--device-url',
    '192.0.2.10',
    '--id',
    '0',
  ]);

  expect(status).toMatchObject({
    command: 'http-request',
    operation: 'device.status',
    stakesTier: 'green',
    httpRequest: {
      url: 'http://192.0.2.10/rpc/Shelly.GetStatus',
      method: 'GET',
      skillName: 'shelly',
      stakesTier: 'green',
    },
  });
  expect(components.httpRequest).toMatchObject({
    url: 'http://192.0.2.10/rpc',
    method: 'POST',
    json: {
      id: 1,
      method: 'Shelly.GetComponents',
      params: {
        include: ['status', 'config'],
        keys: ['switch:0'],
      },
    },
  });
  expect(coverConfig).toMatchObject({
    operation: 'cover.config',
    stakesTier: 'green',
    httpRequest: {
      url: 'http://192.0.2.10/rpc/Cover.GetConfig?id=0',
      method: 'GET',
    },
  });
  expect(coverStatus.httpRequest.url).toBe(
    'http://192.0.2.10/rpc/Cover.GetStatus?id=0',
  );
  expect(
    shelly.buildRequest([
      '--format',
      'json',
      'cover',
      'status',
      '--device-url',
      '192.0.2.10',
      '--id',
      '0',
    ]),
  ).toMatchObject({
    operation: 'cover.status',
    httpRequest: {
      url: 'http://192.0.2.10/rpc/Cover.GetStatus?id=0',
      method: 'GET',
    },
  });
});

test('Shelly helper requires approval before local output changes', () => {
  const denied = runHelper([
    '--format',
    'json',
    'switch',
    'set',
    '--device-url',
    'http://192.0.2.10',
    '--id',
    '0',
    '--on',
    'true',
  ]);
  const deniedCover = runHelper([
    '--format',
    'json',
    'cover',
    'open',
    '--device-url',
    'http://192.0.2.10',
    '--id',
    '0',
  ]);
  const allowed = request([
    'switch',
    'set',
    '--device-url',
    'http://192.0.2.10',
    '--id',
    '0',
    '--on',
    'true',
    '--toggle-after',
    '5',
    '--operator-grant',
  ]);
  const coverOpen = request([
    'cover',
    'open',
    '--device-url',
    'http://192.0.2.10',
    '--id',
    '0',
    '--duration',
    '5',
    '--tag',
    'hybridclaw',
    '--operator-grant',
  ]);
  const coverGoto = request([
    'cover',
    'goto',
    '--device-url',
    'http://192.0.2.10',
    '--id',
    '0',
    '--position',
    '50',
    '--slat-position',
    '30',
    '--operator-grant',
  ]);
  const coverGotoPlan = approvalPlan([
    'cover',
    'goto',
    '--device-url',
    'http://192.0.2.10',
    '--id',
    '0',
    '--position',
    '50',
  ]);

  expect(denied.status).not.toBe(0);
  expect(denied.stderr).toContain('switch.set is amber');
  expect(deniedCover.status).not.toBe(0);
  expect(deniedCover.stderr).toContain('cover.open is amber');
  expect(allowed).toMatchObject({
    operation: 'switch.set',
    stakesTier: 'amber',
    httpRequest: {
      url: 'http://192.0.2.10/rpc',
      method: 'POST',
      json: {
        method: 'Switch.Set',
        params: {
          id: 0,
          on: true,
          toggle_after: 5,
        },
      },
    },
  });
  expect(coverOpen).toMatchObject({
    operation: 'cover.open',
    stakesTier: 'amber',
    httpRequest: {
      url: 'http://192.0.2.10/rpc',
      method: 'POST',
      json: {
        method: 'Cover.Open',
        params: {
          id: 0,
          duration: 5,
          tag: 'hybridclaw',
        },
      },
    },
  });
  expect(coverGoto).toMatchObject({
    operation: 'cover.goto',
    stakesTier: 'amber',
    httpRequest: {
      url: 'http://192.0.2.10/rpc',
      method: 'POST',
      json: {
        method: 'Cover.GoToPosition',
        params: {
          id: 0,
          pos: 50,
          slat_pos: 30,
        },
      },
    },
  });
  expect(coverGotoPlan).toMatchObject({
    command: 'approval-plan',
    operation: 'cover.goto',
    stakesTier: 'amber',
    target: {
      host: '192.0.2.10',
      path: '/rpc',
      method: 'POST',
    },
    rpcMethod: 'Cover.GoToPosition',
    params: {
      id: 0,
      pos: 50,
    },
  });
  expect(coverGotoPlan).not.toHaveProperty('httpRequest');
  expect(coverGotoPlan.approvedHelperCommandText).toContain('cover goto');
  expect(coverGotoPlan.approvedHelperCommandText).toContain('--operator-grant');
});

test('Shelly helper builds local Gen1 relay requests', () => {
  const status = request([
    'relay',
    'status',
    '--device-url',
    'http://192.0.2.20',
    '--id',
    '1',
  ]);
  const set = request([
    'relay',
    'set',
    '--device-url',
    'http://192.0.2.20',
    '--id',
    '1',
    '--turn',
    'toggle',
    '--timer',
    '10',
    '--operator-grant',
  ]);

  expect(status.httpRequest.url).toBe('http://192.0.2.20/relay/1');
  expect(status.stakesTier).toBe('green');
  expect(set).toMatchObject({
    operation: 'relay.set',
    stakesTier: 'amber',
    httpRequest: {
      url: 'http://192.0.2.20/relay/1?turn=toggle&timer=10',
      method: 'GET',
    },
  });
});

test('Shelly helper builds generic Gen1 endpoint requests', () => {
  const get = request([
    'gen1',
    'get',
    '--device-url',
    'http://192.0.2.20',
    '--path',
    '/settings',
  ]);
  const set = request([
    'gen1',
    'set',
    '--device-url',
    'http://192.0.2.20',
    '--path',
    '/settings/relay/0',
    '--query',
    'default_state=on',
    '--operator-grant',
  ]);

  expect(get).toMatchObject({
    operation: 'gen1.get',
    stakesTier: 'green',
    httpRequest: {
      url: 'http://192.0.2.20/settings',
      method: 'GET',
    },
  });
  expect(set).toMatchObject({
    operation: 'gen1.set',
    stakesTier: 'amber',
    httpRequest: {
      url: 'http://192.0.2.20/settings/relay/0?default_state=on',
      method: 'GET',
    },
  });
});

test('Shelly helper builds generic Gen2 RPC requests', () => {
  const get = request([
    'rpc',
    'get',
    '--device-url',
    'http://192.0.2.10',
    '--method',
    'Cloud.GetStatus',
  ]);
  const call = request([
    'rpc',
    'call',
    '--device-url',
    'http://192.0.2.10',
    '--method',
    'Cover.Calibrate',
    '--params-json',
    '{"id":0}',
    '--operator-grant',
  ]);
  const plan = approvalPlan([
    'rpc',
    'call',
    '--device-url',
    'http://192.0.2.10',
    '--method',
    'Cover.ResetCounters',
    '--params-json',
    '{"id":0,"type":["aenergy"]}',
  ]);

  expect(get).toMatchObject({
    operation: 'rpc.get',
    stakesTier: 'green',
    httpRequest: {
      url: 'http://192.0.2.10/rpc/Cloud.GetStatus',
      method: 'GET',
    },
  });
  expect(call).toMatchObject({
    operation: 'rpc.call',
    stakesTier: 'amber',
    httpRequest: {
      url: 'http://192.0.2.10/rpc',
      method: 'POST',
      json: {
        method: 'Cover.Calibrate',
        params: {
          id: 0,
        },
      },
    },
  });
  expect(plan).toMatchObject({
    command: 'approval-plan',
    operation: 'rpc.call',
    rpcMethod: 'Cover.ResetCounters',
    params: {
      id: 0,
      type: ['aenergy'],
    },
  });
  expect(plan.approvedHelperCommandText).toContain('rpc call');
  expect(plan.approvedHelperCommandText).toContain('--operator-grant');
});

test('Shelly helper builds cloud state and control requests without exposing secrets', () => {
  const state = request([
    'cloud',
    'state',
    '--cloud-host',
    'https://shelly.example.com',
    '--device-id',
    'b48a0a1cd978',
    '--select',
    'status',
    '--pick-status',
    'sys',
  ]);
  const setSwitch = request([
    'switch',
    'set',
    '--cloud-host',
    'shelly.example.com',
    '--device-id',
    'b48a0a1cd978',
    '--channel',
    '0',
    '--on',
    'false',
    '--operator-grant',
  ]);

  expect(state).toMatchObject({
    operation: 'cloud.state',
    stakesTier: 'green',
    httpRequest: {
      url: 'https://shelly.example.com/v2/devices/api/get?auth_key=<secret:SHELLY_CLOUD_AUTH_KEY>',
      method: 'POST',
      json: {
        ids: ['b48a0a1cd978'],
        select: ['status'],
        pick: {
          status: ['sys'],
        },
      },
    },
    liveExecution: {
      requiresConfiguredSecrets: ['SHELLY_CLOUD_AUTH_KEY'],
    },
  });
  expect(setSwitch.httpRequest).toMatchObject({
    url: 'https://shelly.example.com/v2/devices/api/set/switch?auth_key=<secret:SHELLY_CLOUD_AUTH_KEY>',
    method: 'POST',
    json: {
      id: 'b48a0a1cd978',
      channel: 0,
      on: false,
    },
  });
  expect(JSON.stringify(state)).not.toContain('supersecret');
  expect(state.httpRequest).not.toHaveProperty('bearerSecretName');
});

test('Shelly helper builds OAuth-backed Real Time Events all-status requests', () => {
  const token = request([
    'cloud',
    'oauth-token',
    '--cloud-host',
    'https://shelly.example.com',
    '--code-secret',
    'SHELLY_OAUTH_CODE',
  ]);
  const payload = request([
    'cloud',
    'all-status',
    '--cloud-host',
    'https://shelly.example.com',
  ]);
  const includeShared = request([
    'cloud',
    'all-status',
    '--cloud-host',
    'shelly.example.com',
    '--include-shared',
    '--without-info',
  ]);
  const websocket = request([
    'cloud',
    'websocket-url',
    '--cloud-host',
    'https://shelly.example.com',
  ]);
  const websocketCommand = request([
    'cloud',
    'websocket-command',
    '--cloud-host',
    'https://shelly.example.com',
    '--device-id',
    'b48a0a1cd978',
    '--cmd',
    'roller_to_pos',
    '--params-json',
    '{"id":0,"pos":50}',
    '--operator-grant',
  ]);

  expect(token).toMatchObject({
    operation: 'cloud.oauth-token',
    stakesTier: 'green',
    httpRequest: {
      url: 'https://shelly.example.com/oauth/auth',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'client_id=shelly-diy&grant_type=code&code=<secret:SHELLY_OAUTH_CODE>',
      replaceSecretPlaceholders: true,
      captureResponseFields: [
        {
          jsonPath: 'access_token',
          secretName: 'SHELLY_CLOUD_ACCESS_TOKEN',
        },
      ],
    },
    liveExecution: {
      requiresConfiguredSecrets: ['SHELLY_OAUTH_CODE'],
      capturesSecrets: ['SHELLY_CLOUD_ACCESS_TOKEN'],
    },
  });
  expect(payload).toMatchObject({
    operation: 'cloud.all-status',
    stakesTier: 'green',
    httpRequest: {
      url: 'https://shelly.example.com/device/all_status?show_info=true&no_shared=true',
      method: 'GET',
      skillName: 'shelly',
      maxResponseBytes: 5_000_000,
      secretHeaders: [
        {
          name: 'Authorization',
          secretName: 'SHELLY_CLOUD_ACCESS_TOKEN',
          prefix: 'Bearer',
        },
      ],
    },
    liveExecution: {
      requiresConfiguredSecrets: ['SHELLY_CLOUD_ACCESS_TOKEN'],
    },
  });
  expect(includeShared.httpRequest.url).toBe(
    'https://shelly.example.com/device/all_status?show_info=false&no_shared=false',
  );
  expect(websocket).toMatchObject({
    command: 'websocket',
    operation: 'cloud.websocket-url',
    stakesTier: 'green',
    webSocket: {
      urlTemplate:
        'wss://shelly.example.com:6113/shelly/wss/hk_sock?t=<secret:SHELLY_CLOUD_ACCESS_TOKEN>',
      replaceSecretPlaceholders: true,
    },
    liveExecution: {
      requiresConfiguredSecrets: ['SHELLY_CLOUD_ACCESS_TOKEN'],
    },
  });
  expect(websocketCommand).toMatchObject({
    command: 'websocket',
    operation: 'cloud.websocket-command',
    stakesTier: 'amber',
    webSocket: {
      message: {
        event: 'Shelly:CommandRequest',
        deviceId: 'b48a0a1cd978',
        data: {
          cmd: 'roller_to_pos',
          params: {
            id: 0,
            pos: 50,
          },
        },
      },
    },
  });
  expect(JSON.stringify(token)).not.toContain('authorization-code-value');
  expect(JSON.stringify(payload)).not.toContain('access-token-value');
});

test('Shelly helper rejects light and cover commands with only routing fields', () => {
  const light = runHelper([
    '--format',
    'json',
    'light',
    'set',
    '--cloud-host',
    'https://shelly.example.com',
    '--device-id',
    'b48a0a1cd978',
    '--channel',
    '0',
    '--operator-grant',
  ]);
  const cover = runHelper([
    '--format',
    'json',
    'cover',
    'goto',
    '--cloud-host',
    'https://shelly.example.com',
    '--device-id',
    'b48a0a1cd978',
    '--channel',
    '0',
    '--operator-grant',
  ]);

  expect(light.status).not.toBe(0);
  expect(light.stderr).toContain(
    'light.set requires at least one light command field.',
  );
  expect(cover.status).not.toBe(0);
  expect(cover.stderr).toContain(
    'cover.goto requires --position, --relative, --slat-position, or --slat-relative.',
  );
});

test('Shelly helper rejects credential-bearing local URLs and non-HTTPS cloud hosts', () => {
  const local = runHelper([
    '--format',
    'json',
    'device',
    'info',
    '--device-url',
    'http://admin:password@192.0.2.10',
  ]);
  const cloud = runHelper([
    '--format',
    'json',
    'cloud',
    'state',
    '--cloud-host',
    'http://shelly.example.com',
    '--device-id',
    'b48a0a1cd978',
  ]);

  expect(local.status).not.toBe(0);
  expect(local.stderr).toContain('must not embed credentials');
  expect(cloud.status).not.toBe(0);
  expect(cloud.stderr).toContain('must use https');
});

test('Shelly helper blocks disallowed destructive maintenance operations', () => {
  const rebootRpc = runHelper([
    '--format',
    'json',
    'rpc',
    'call',
    '--device-url',
    'http://192.0.2.10',
    '--method',
    'Shelly.Reboot',
    '--operator-grant',
  ]);
  const rebootGen1 = runHelper([
    '--format',
    'json',
    'gen1',
    'set',
    '--device-url',
    'http://192.0.2.20',
    '--path',
    '/reboot',
    '--operator-grant',
  ]);
  const nonReadRpcGet = runHelper([
    '--format',
    'json',
    'rpc',
    'get',
    '--device-url',
    'http://192.0.2.10',
    '--method',
    'Cover.Open',
  ]);

  expect(rebootRpc.status).not.toBe(0);
  expect(rebootRpc.stderr).toContain('Shelly.Reboot is not allowed');
  expect(rebootGen1.status).not.toBe(0);
  expect(rebootGen1.stderr).toContain('/reboot is not allowed');
  expect(nonReadRpcGet.status).not.toBe(0);
  expect(nonReadRpcGet.stderr).toContain('rpc get only allows read methods');
});
