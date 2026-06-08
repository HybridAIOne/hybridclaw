import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { expect, test } from 'vitest';

import { parseSkillManifestFromMarkdown } from '../src/skills/skill-manifest.js';

const skillRoot = path.join(process.cwd(), 'skills', 'hue');
const helperPath = path.join(skillRoot, 'hue.cjs');
const skillPath = path.join(skillRoot, 'SKILL.md');
const require = createRequire(import.meta.url);
const hue = require('../skills/hue/hue.cjs');

function runHelper(args: string[]) {
  return spawnSync('node', [helperPath, ...args], { encoding: 'utf-8' });
}

function request(args: string[]) {
  return hue.buildRequest(['--format', 'json', ...args]);
}

test('Hue skill manifest declares env store host, SecretRefs, and guarded stakes', () => {
  const skill = fs.readFileSync(skillPath, 'utf-8');
  const manifest = parseSkillManifestFromMarkdown(skill, { name: 'hue' });

  expect(manifest.configVariables).toEqual([
    {
      id: 'hue-bridge-host',
      env: 'HUE_BRIDGE_HOST',
      required: true,
      scope: 'Local Hue Bridge HTTPS base URL used in gateway http_request URLs',
      howToObtain:
        'Find the bridge IP through the Hue app, router DHCP table, mDNS, or discovery.meethue.com, then store it with `hybridclaw env set HUE_BRIDGE_HOST "https://192.168.1.30"`.',
    },
  ]);
  expect(manifest.credentials?.[0]).toMatchObject({
    id: 'hue-application-key',
    secretRef: { source: 'store', id: 'HUE_APPLICATION_KEY' },
  });
  expect(skill).toContain('category: home-automation');
  expect(skill).toContain('local-light-list');
  expect(skill).toContain('local-light-brightness');
  expect(skill).toContain('local-bridge-config-timezone');
  expect(skill).toContain('managed read-only LAN access');
  expect(skill).toContain('do not tell the operator a gateway restart');
  expect(skill).toContain('hybridclaw env list');
  expect(skill).toContain('hybridclaw secret list');
  expect(skill).toContain('Do not ask whether to check config');
  expect(skill).toContain(
    'If `HUE_BRIDGE_HOST` is configured and `HUE_APPLICATION_KEY` is missing',
  );
  expect(skill).toContain('find the bridge IP again');
  expect(skill).not.toContain('CLIP v1');
});

test('Hue helper --help lists subject verb commands', () => {
  const result = runHelper(['--help']);

  expect(result.status).toBe(0);
  expect(result.stdout).toContain('Hue request helper');
  expect(result.stdout).toContain('light list');
  expect(result.stdout).toContain('grouped-light brightness --id');
  expect(result.stdout).toContain('scene recall --id');
  expect(result.stdout).toContain('bridge link [--host URL]');
  expect(result.stdout).not.toContain('setup-local');
  expect(result.stdout).not.toContain('HYBRIDCLAW_GATEWAY_URL');
});

test('Hue helper builds local CLIP v2 reads without exposing secrets', () => {
  const lights = request(['light', 'list']);
  const room = request([
    'room',
    'get',
    '--id',
    'room-1',
    '--host',
    'https://192.0.2.30',
  ]);

  expect(lights).toMatchObject({
    command: 'http-request',
    operation: 'local-light-list',
    stakesTier: 'green',
    httpRequest: {
      url: '<env:HUE_BRIDGE_HOST>/clip/v2/resource/light',
      method: 'GET',
      secretHeaders: [
        {
          name: 'hue-application-key',
          secretName: 'HUE_APPLICATION_KEY',
          prefix: 'none',
        },
      ],
      replaceSecretPlaceholders: true,
      allowSelfSignedTls: true,
      skillName: 'hue',
    },
  });
  expect(room.httpRequest.url).toBe(
    'https://192.0.2.30/clip/v2/resource/room/room-1',
  );
  expect(JSON.stringify(lights)).not.toContain('test-application-key');
});

test('Hue helper builds bounded eventstream reads', () => {
  const eventstream = request(['eventstream', 'read', '--duration', '30s']);

  expect(eventstream).toMatchObject({
    operation: 'local-eventstream',
    stakesTier: 'green',
    httpRequest: {
      url: '<env:HUE_BRIDGE_HOST>/eventstream/clip/v2',
      method: 'GET',
      timeoutMs: 30_000,
      maxResponseBytes: 2_000_000,
      headers: { Accept: 'text/event-stream' },
    },
  });
});

test('Hue helper builds granted local mutation request shapes', () => {
  const brightness = request([
    'light',
    'brightness',
    '--id',
    'light-1',
    '--pct',
    '60',
  ]);
  const scene = request(['scene', 'recall', '--id', 'scene-1']);
  const bridgeTimezone = request([
    'bridge',
    'timezone',
    '--id',
    'bridge-1',
    '--timezone',
    'Europe/Berlin',
  ]);

  expect(brightness).toMatchObject({
    operation: 'local-light-brightness',
    stakesTier: 'amber',
    requiredGrant: 'approve-hue-write',
    httpRequest: {
      method: 'PUT',
      url: '<env:HUE_BRIDGE_HOST>/clip/v2/resource/light/light-1',
      json: { dimming: { brightness: 60 } },
    },
  });
  expect(scene.httpRequest.json).toEqual({ recall: { action: 'active' } });
  expect(bridgeTimezone).toMatchObject({
    stakesTier: 'red',
    requiredGrant: 'approve-hue-bridge-config',
    httpRequest: {
      json: { time_zone: { time_zone: 'Europe/Berlin' } },
    },
  });
});

test('Hue helper builds link and remote request shapes without runtime side effects', () => {
  const link = request(['bridge', 'link', '--app-name', 'hybridclaw', '--instance-name', 'lab']);
  const linkWithHost = request([
    'bridge',
    'link',
    '--host',
    'https://192.0.2.30',
    '--app-name',
    'hybridclaw',
    '--instance-name',
    'lab',
  ]);
  const remoteLights = request(['remote', 'light', 'list', '--bridge', 'bridge-1']);
  const remoteOauth = request(['remote', 'oauth-token']);

  expect(link).toMatchObject({
    operation: 'local-link-button',
    stakesTier: 'amber',
    httpRequest: {
      method: 'POST',
      url: '<env:HUE_BRIDGE_HOST>/api',
      json: {
        devicetype: 'hybridclaw#lab',
        generateclientkey: true,
      },
    },
  });
  expect(linkWithHost.httpRequest.url).toBe('https://192.0.2.30/api');
  expect(link).not.toHaveProperty('liveExecution');
  expect(remoteLights).toMatchObject({
    operation: 'remote-light-list',
    httpRequest: {
      url: 'https://api.meethue.com/route/clip/v2/resource/light?bridge_id=bridge-1',
      secretHeaders: [
        {
          name: 'Authorization',
          secretName: 'HUE_REMOTE_ACCESS_TOKEN',
          prefix: 'Bearer',
        },
      ],
    },
  });
  expect(remoteOauth.httpRequest.form).toMatchObject({
    refresh_token: '<secret:HUE_REMOTE_REFRESH_TOKEN>',
    client_id: '<secret:HUE_REMOTE_CLIENT_ID>',
    client_secret: '<secret:HUE_REMOTE_CLIENT_SECRET>',
  });
  expect(JSON.stringify(remoteOauth)).not.toContain('client-secret-value');
});

test('Hue helper rejects arbitrary subjects and invalid placeholders early', () => {
  const subjectResult = runHelper(['--format', 'json', '../../config', 'list']);
  const secretTemplateResult = runHelper([
    '--format',
    'json',
    'light',
    'list',
    '--host',
    '<secret:HUE_BRIDGE_HOST>',
  ]);
  const envTemplateResult = runHelper([
    '--format',
    'json',
    'light',
    'list',
    '--host',
    '<env:hue-bridge-host>',
  ]);

  expect(subjectResult.status).not.toBe(0);
  expect(subjectResult.stderr).toContain('Unsupported Hue subject');
  expect(secretTemplateResult.status).not.toBe(0);
  expect(secretTemplateResult.stderr).toContain(
    '--host URL placeholder must use <env:NAME>',
  );
  expect(envTemplateResult.status).not.toBe(0);
  expect(envTemplateResult.stderr).toContain(
    '--host env placeholder must be exactly <env:NAME>',
  );
});

test('Hue helper only exports request construction', () => {
  expect(Object.keys(hue).sort()).toEqual(['buildRequest']);
});
