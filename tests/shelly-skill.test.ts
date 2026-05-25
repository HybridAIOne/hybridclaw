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
  return shelly.buildRequest(['--format', 'json', 'http-request', ...args]);
}

test('Shelly skill manifest declares optional cloud credential and guarded operations', () => {
  const skill = fs.readFileSync(skillPath, 'utf-8');
  const manifest = parseSkillManifestFromMarkdown(skill, { name: 'shelly' });

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
  expect(skill).toContain('local-gen2-switch-set');
  expect(skill).toContain('cloud-set-cover');
  expect(skill).toContain('factory-reset');
  expect(skill).toContain('Device Discovery and IDs');
  expect(skill).toContain(
    'Do not claim that the v2\n`auth_key` API can list every device.',
  );
  expect(skill).toContain('/device/all_status?show_info=true&no_shared=true');
  expect(skill).toContain('OAuth/Bearer\n  access-token authentication');
  expect(skill).toContain('OAuth Token Acquisition');
  expect(skill).toContain('cloud-oauth-token');
  expect(skill).toContain('Pipedream RequestBin');
  expect(skill).toContain('redirect_uri=<request-bin-url>');
  expect(skill).toContain('captureResponseFields');
  expect(skill).toContain(
    "mirrors the Salesforce skill's\ngateway capture pattern",
  );
  expect(skill).toContain('cloud-all-status');
  expect(skill).toContain('Names and Rooms');
  expect(skill).toContain(
    'Do not say Shelly App names or room names are unset',
  );
  expect(skill).toContain('this endpoint did not return names');
  expect(skill).toContain(
    'Do not claim that nobody named the devices in the\n  Shelly app.',
  );
  expect(skill).toContain('Evidence and Reporting Rules');
  expect(skill).toContain(
    'Do not report capabilities, device lists,\nnames, rooms, or command readiness from intent, docs, or partial failures.',
  );
  expect(skill).toContain('Use this credential decision matrix');
  expect(skill).toContain('Cannot list all devices through v2.');
  expect(skill).toContain(
    'Do not promise account-wide cloud discovery unless\n  `SHELLY_CLOUD_ACCESS_TOKEN` is configured.',
  );
});

test('Shelly helper --help exits cleanly and lists local and cloud operations', () => {
  const result = runHelper(['--help']);

  expect(result.status).toBe(0);
  expect(result.stdout).toContain('Shelly skill helper');
  expect(result.stdout).toContain('local-gen2-status');
  expect(result.stdout).toContain('local-gen1-relay-set');
  expect(result.stdout).toContain('cloud-get-state');
  expect(result.stdout).toContain('cloud-oauth-token');
  expect(result.stdout).toContain('cloud-all-status');
  expect(result.stdout).toContain('cloud-set-switch');
});

test('Shelly helper builds local Gen2 RPC read requests', () => {
  const status = request([
    'local-gen2-status',
    '--device-url',
    'http://192.0.2.10',
  ]);
  const components = request([
    'local-gen2-components',
    '--device-url',
    '192.0.2.10',
    '--include',
    'status',
    '--include',
    'config',
    '--key',
    'switch:0',
  ]);

  expect(status).toMatchObject({
    command: 'http-request',
    operation: 'local-gen2-status',
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
});

test('Shelly helper requires approval before local output changes', () => {
  const denied = runHelper([
    '--format',
    'json',
    'http-request',
    'local-gen2-switch-set',
    '--device-url',
    'http://192.0.2.10',
    '--id',
    '0',
    '--on',
    'true',
  ]);
  const allowed = request([
    'local-gen2-switch-set',
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

  expect(denied.status).not.toBe(0);
  expect(denied.stderr).toContain('local-gen2-switch-set is amber');
  expect(allowed).toMatchObject({
    operation: 'local-gen2-switch-set',
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
});

test('Shelly helper builds local Gen1 relay requests', () => {
  const status = request([
    'local-gen1-relay-status',
    '--device-url',
    'http://192.0.2.20',
    '--id',
    '1',
  ]);
  const set = request([
    'local-gen1-relay-set',
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
    operation: 'local-gen1-relay-set',
    stakesTier: 'amber',
    httpRequest: {
      url: 'http://192.0.2.20/relay/1?turn=toggle&timer=10',
      method: 'GET',
    },
  });
});

test('Shelly helper builds cloud state and control requests without exposing secrets', () => {
  const state = request([
    'cloud-get-state',
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
    'cloud-set-switch',
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
    operation: 'cloud-get-state',
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
    'cloud-oauth-token',
    '--cloud-host',
    'https://shelly.example.com',
    '--code-secret',
    'SHELLY_OAUTH_CODE',
  ]);
  const payload = request([
    'cloud-all-status',
    '--cloud-host',
    'https://shelly.example.com',
  ]);
  const includeShared = request([
    'cloud-all-status',
    '--cloud-host',
    'shelly.example.com',
    '--include-shared',
    '--without-info',
  ]);

  expect(token).toMatchObject({
    operation: 'cloud-oauth-token',
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
    operation: 'cloud-all-status',
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
  expect(JSON.stringify(token)).not.toContain('authorization-code-value');
  expect(JSON.stringify(payload)).not.toContain('access-token-value');
});

test('Shelly helper rejects light and cover commands with only routing fields', () => {
  const light = runHelper([
    '--format',
    'json',
    'http-request',
    'cloud-set-light',
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
    'http-request',
    'cloud-set-cover',
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
    'cloud-set-light requires at least one light command field.',
  );
  expect(cover.status).not.toBe(0);
  expect(cover.stderr).toContain(
    'cloud-set-cover requires at least one cover command field.',
  );
});

test('Shelly helper rejects credential-bearing local URLs and non-HTTPS cloud hosts', () => {
  const local = runHelper([
    '--format',
    'json',
    'http-request',
    'local-gen2-info',
    '--device-url',
    'http://admin:password@192.0.2.10',
  ]);
  const cloud = runHelper([
    '--format',
    'json',
    'http-request',
    'cloud-get-state',
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
