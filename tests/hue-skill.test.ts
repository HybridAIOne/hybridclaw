import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { expect, test, vi } from 'vitest';

import { parseSkillManifestFromMarkdown } from '../src/skills/skill-manifest.js';

const skillRoot = path.join(process.cwd(), 'skills', 'hue');
const helperPath = path.join(skillRoot, 'hue.cjs');
const skillPath = path.join(skillRoot, 'SKILL.md');
const require = createRequire(import.meta.url);
const hue = require('../skills/hue/hue.cjs');

function runHelper(args: string[]) {
  return spawnSync('node', [helperPath, ...args], {
    encoding: 'utf-8',
  });
}

function request(args: string[]) {
  return hue.buildRequest(['--format', 'json', ...args]);
}

test('Hue skill manifest declares SecretRefs and guarded stakes', () => {
  const skill = fs.readFileSync(skillPath, 'utf-8');
  const manifest = parseSkillManifestFromMarkdown(skill, { name: 'hue' });

  expect(manifest.credentials).toEqual([
    {
      id: 'hue-bridge-host',
      kind: 'header',
      required: true,
      secretRef: {
        source: 'store',
        id: 'HUE_BRIDGE_HOST',
      },
      scope: 'Local Hue Bridge HTTPS base URL used by gateway http_request',
      howToObtain:
        'Find the bridge IP through the Hue app, router DHCP table, mDNS, or discovery.meethue.com, then store it with `hybridclaw secret set HUE_BRIDGE_HOST "https://192.168.1.30"`.',
    },
    {
      id: 'hue-application-key',
      kind: 'api_key',
      required: true,
      secretRef: {
        source: 'store',
        id: 'HUE_APPLICATION_KEY',
      },
      scope: 'Philips Hue CLIP v2 hue-application-key header',
      howToObtain:
        'Press the bridge link button and run `node skills/hue/hue.cjs --format json link --host https://192.168.1.30 --app-name hybridclaw --instance-name lab`; the helper stores the returned key as `HUE_APPLICATION_KEY`.',
    },
    {
      id: 'hue-bridge-tls-sha256',
      kind: 'header',
      required: false,
      secretRef: {
        source: 'store',
        id: 'HUE_BRIDGE_TLS_SHA256',
      },
      scope:
        'Operator-pinned SHA-256 fingerprint for the local bridge TLS certificate',
      howToObtain:
        'Record the Hue Bridge certificate SHA-256 fingerprint out of band and store it with `hybridclaw secret set HUE_BRIDGE_TLS_SHA256 "<sha256>"`; do not disable TLS verification globally.',
    },
    {
      id: 'hue-remote-refresh-token',
      kind: 'bearer',
      required: false,
      secretRef: {
        source: 'store',
        id: 'HUE_REMOTE_REFRESH_TOKEN',
      },
      scope: 'Hue Remote API OAuth token used for off-LAN API calls',
      howToObtain:
        'Create a Hue developer app, complete the Hue Remote API OAuth flow, and store the refresh/access token with `hybridclaw secret set HUE_REMOTE_REFRESH_TOKEN "<token>"`.',
    },
    {
      id: 'hue-remote-access-token',
      kind: 'bearer',
      required: false,
      secretRef: {
        source: 'store',
        id: 'HUE_REMOTE_ACCESS_TOKEN',
      },
      scope:
        'Hue Remote API short-lived access token used as Authorization bearer',
      howToObtain:
        'Run `node skills/hue/hue.cjs --format json http-request remote-oauth-token` after configuring the Remote API client id, client secret, and refresh token; the gateway captures the access token into `HUE_REMOTE_ACCESS_TOKEN`.',
    },
  ]);
  expect(skill).toContain('category: home-automation');
  expect(skill).toContain('related_roadmap:');
  expect(skill).toContain('R21.114');
  expect(skill).toContain('stakes_tiers:');
  expect(skill).toContain('local-light-list');
  expect(skill).toContain('local-light-brightness');
  expect(skill).toContain('local-scene-create');
  expect(skill).toContain('remote-oauth-token');
  expect(skill).toContain('local-bridge-config-timezone');
  expect(skill).toContain('approval-plan');
  expect(skill).toContain('approvedHelperCommandText');
  expect(skill).toContain('OpenHue');
  expect(skill).toContain('Do not use CLIP v1 for new writes');
});

test('Hue helper --help exits cleanly and lists local, remote, and plan commands', () => {
  const result = runHelper(['--help']);

  expect(result.status).toBe(0);
  expect(result.stdout).toContain('Hue skill helper');
  expect(result.stdout).toContain('http-request bridge');
  expect(result.stdout).toContain('http-request eventstream');
  expect(result.stdout).toContain('remote-lights');
  expect(result.stdout).toContain('remote-oauth-token');
  expect(result.stdout).toContain('plan light-brightness');
  expect(result.stdout).toContain('plan group-recall-scene');
  expect(result.stdout).toContain('plan scene-create');
  expect(result.stdout).toContain('link --host');
  expect(result.stdout).not.toContain('--application-key');
  expect(result.stdout).not.toContain('--refresh-token');
});

test('Hue helper builds local CLIP v2 resource-list requests without exposing secrets', () => {
  const bridge = request(['--request', 'http-request', 'bridge']);
  const lights = request([
    '--request',
    'http-request',
    'lights',
    '--host',
    'https://192.0.2.30',
    '--tls-sha256',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  ]);

  expect(bridge).toMatchObject({
    command: 'http-request',
    operation: 'local-bridge-list',
    stakesTier: 'green',
    httpRequest: {
      url: '<secret:HUE_BRIDGE_HOST>/clip/v2/resource/bridge',
      method: 'GET',
      secretHeaders: [
        {
          name: 'hue-application-key',
          secretName: 'HUE_APPLICATION_KEY',
          prefix: 'none',
        },
      ],
      replaceSecretPlaceholders: true,
      tlsCertificateSha256SecretName: 'HUE_BRIDGE_TLS_SHA256',
      skillName: 'hue',
    },
  });
  expect(lights.httpRequest.url).toBe(
    'https://192.0.2.30/clip/v2/resource/light',
  );
  expect(lights.httpRequest.tlsCertificateSha256).toBe(
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  );
  expect(lights.tls.sha256).toBe(
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  );
  expect(JSON.stringify(bridge)).not.toContain('test-application-key');
});

test('Hue helper builds eventstream and v1 fallback reads as bounded requests', () => {
  const eventstream = request([
    '--request',
    'http-request',
    'eventstream',
    '--duration',
    '30s',
  ]);
  const v1 = request(['--request', 'http-request', 'v1-lights']);

  expect(eventstream.httpRequest).toMatchObject({
    url: '<secret:HUE_BRIDGE_HOST>/eventstream/clip/v2',
    method: 'GET',
    timeoutMs: 30_000,
    headers: {
      Accept: 'text/event-stream',
    },
  });
  expect(eventstream.secretRefPolicy).toContain('occupancy');
  expect(v1).toMatchObject({
    operation: 'local-v1-lights',
    stakesTier: 'green',
    target: {
      apiVersion: 'clip-v1-read-only',
    },
  });
  expect(v1.httpRequest.url).toContain('<secret:HUE_BRIDGE_USERNAME_V1>');
});

test('Hue helper emits approval plans before light and scene mutations', () => {
  const brightness = request([
    'plan',
    'light-brightness',
    '--light',
    'light-1',
    '--pct',
    '60',
  ]);
  const scene = request(['plan', 'group-recall-scene', '--scene', 'scene-1']);

  expect(brightness).toMatchObject({
    command: 'approval-plan',
    operation: 'light-brightness',
    stakesTier: 'amber',
    requiredGrant: 'approve-hue-write',
    target: {
      type: 'light',
      id: 'light-1',
      action: 'brightness',
      pct: 60,
    },
    requestPreview: {
      method: 'PUT',
      url: '<secret:HUE_BRIDGE_HOST>/clip/v2/resource/light/light-1',
      json: {
        dimming: {
          brightness: 60,
        },
      },
    },
  });
  expect(brightness).not.toHaveProperty('httpRequest');
  expect(brightness.approvedHelperCommandText).toContain(
    '--operator-grant approve-hue-write',
  );
  expect(brightness.approvedHelperCommandText).toContain('--light light-1');
  expect(scene.requestPreview.json).toEqual({
    recall: {
      action: 'active',
    },
  });
});

test('Hue helper builds allowed CLIP v2 scene and behavior create requests', () => {
  const scene = request([
    'plan',
    'scene-create',
    '--name',
    'Evening',
    '--group',
    'room-1',
    '--group-type',
    'room',
    '--actions-json',
    '[{"target":{"rid":"light-1","rtype":"light"},"action":{"on":{"on":true},"dimming":{"brightness":55}}}]',
    '--operator-grant',
    'approve-hue-write',
  ]);
  const behavior = request([
    'plan',
    'behavior-create',
    '--name',
    'Vacation',
    '--configuration-json',
    '{"script_id":"example"}',
    '--operator-grant',
    'approve-hue-write',
  ]);

  expect(scene).toMatchObject({
    operation: 'local-scene-create',
    stakesTier: 'amber',
    httpRequest: {
      method: 'POST',
      url: '<secret:HUE_BRIDGE_HOST>/clip/v2/resource/scene',
      json: {
        type: 'scene',
        metadata: {
          name: 'Evening',
        },
        group: {
          rid: 'room-1',
          rtype: 'room',
        },
        actions: [
          {
            target: {
              rid: 'light-1',
              rtype: 'light',
            },
            action: {
              on: {
                on: true,
              },
              dimming: {
                brightness: 55,
              },
            },
          },
        ],
      },
    },
  });
  expect(behavior).toMatchObject({
    operation: 'local-behavior-create',
    httpRequest: {
      method: 'POST',
      url: '<secret:HUE_BRIDGE_HOST>/clip/v2/resource/behavior_instance',
      json: {
        type: 'behavior_instance',
        metadata: {
          name: 'Vacation',
        },
        enabled: true,
        configuration: {
          script_id: 'example',
        },
      },
    },
  });
});

test('Hue helper builds Remote API reads and granted remote mutations', () => {
  const remoteRooms = request([
    '--request',
    'http-request',
    'remote-rooms',
    '--bridge',
    'bridge-1',
  ]);
  const remoteLight = request([
    'plan',
    'light-on',
    '--remote',
    '--remote-bridge',
    'bridge-1',
    '--light',
    'light-1',
    '--operator-grant',
    'approve-hue-write',
  ]);

  expect(remoteRooms).toMatchObject({
    operation: 'remote-room-list',
    stakesTier: 'amber',
    httpRequest: {
      url: 'https://api.meethue.com/route/clip/v2/resource/room?bridge_id=bridge-1',
      secretHeaders: [
        {
          name: 'Authorization',
          secretName: 'HUE_REMOTE_ACCESS_TOKEN',
          prefix: 'Bearer',
        },
      ],
    },
  });
  expect(remoteLight).toMatchObject({
    operation: 'remote-light-on',
    stakesTier: 'amber',
    httpRequest: {
      method: 'PUT',
      url: 'https://api.meethue.com/route/clip/v2/resource/light/light-1?bridge_id=bridge-1',
      json: {
        on: {
          on: true,
        },
      },
      secretHeaders: [
        {
          name: 'Authorization',
          secretName: 'HUE_REMOTE_ACCESS_TOKEN',
          prefix: 'Bearer',
        },
      ],
    },
  });
  expect(remoteLight.httpRequest).not.toHaveProperty(
    'tlsCertificateSha256SecretName',
  );
});

test('Hue helper emits granted mutation requests with allowlisted shapes only', () => {
  const xy = request([
    'plan',
    'light-color',
    '--light',
    'light-1',
    '--xy',
    '0.4317,0.4147',
    '--operator-grant',
    'approve-hue-write',
  ]);
  const bridgeConfig = request([
    'plan',
    'bridge-config-timezone',
    '--bridge',
    'bridge-1',
    '--timezone',
    'Europe/Berlin',
    '--operator-grant',
    'approve-hue-bridge-config',
  ]);

  expect(xy).toMatchObject({
    command: 'http-request',
    operation: 'local-light-color',
    stakesTier: 'amber',
    requiredGrant: 'approve-hue-write',
    httpRequest: {
      method: 'PUT',
      url: '<secret:HUE_BRIDGE_HOST>/clip/v2/resource/light/light-1',
      json: {
        color: {
          xy: {
            x: 0.4317,
            y: 0.4147,
          },
        },
      },
    },
  });
  expect(bridgeConfig).toMatchObject({
    stakesTier: 'red',
    requiredGrant: 'approve-hue-bridge-config',
    httpRequest: {
      url: '<secret:HUE_BRIDGE_HOST>/clip/v2/resource/bridge/bridge-1',
      json: {
        time_zone: {
          time_zone: 'Europe/Berlin',
        },
      },
    },
  });
});

test('Hue helper rejects arbitrary resource passthrough', () => {
  const result = runHelper([
    '--format',
    'json',
    '--request',
    'http-request',
    '../../config',
  ]);

  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('Unsupported Hue read resource');
});

test('Hue helper builds link and remote requests without secret output', () => {
  const link = request([
    '--request',
    'link',
    '--host',
    'https://192.0.2.30',
    '--app-name',
    'hybridclaw',
    '--instance-name',
    'lab',
  ]);
  const remoteLights = request(['--request', 'http-request', 'remote-lights']);
  const remoteOauth = request([
    '--request',
    'http-request',
    'remote-oauth-token',
  ]);

  expect(link).toMatchObject({
    operation: 'local-link-button',
    stakesTier: 'amber',
    httpRequest: {
      method: 'POST',
      url: 'https://192.0.2.30/api',
      json: {
        devicetype: 'hybridclaw#lab',
        generateclientkey: true,
      },
    },
    liveExecution: {
      capturesSecrets: ['HUE_APPLICATION_KEY'],
    },
  });
  expect(remoteLights).toMatchObject({
    operation: 'remote-lights',
    stakesTier: 'amber',
    httpRequest: {
      url: 'https://api.meethue.com/route/clip/v2/resource/light?bridge_id=<secret:HUE_REMOTE_BRIDGE_ID>',
      secretHeaders: [
        {
          name: 'Authorization',
          secretName: 'HUE_REMOTE_ACCESS_TOKEN',
          prefix: 'Bearer',
        },
      ],
    },
  });
  expect(remoteOauth).toMatchObject({
    operation: 'remote-oauth-token',
    httpRequest: {
      method: 'POST',
      url: 'https://api.meethue.com/v2/oauth2/token',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      captureResponseFields: [
        { jsonPath: 'access_token', secretName: 'HUE_REMOTE_ACCESS_TOKEN' },
        { jsonPath: 'refresh_token', secretName: 'HUE_REMOTE_REFRESH_TOKEN' },
      ],
      replaceSecretPlaceholders: true,
    },
  });
  expect(remoteOauth.httpRequest.body).toContain(
    '<secret:HUE_REMOTE_REFRESH_TOKEN>',
  );
  expect(JSON.stringify(link)).not.toContain('fresh-key');
  expect(JSON.stringify(remoteLights)).not.toContain('refresh-token');
  expect(JSON.stringify(remoteOauth)).not.toContain('client-secret');
});

test('Hue live execution stores link keys through injected SecretRef writer', async () => {
  const payload = request([
    '--request',
    'link',
    '--host',
    'https://192.0.2.30',
    '--app-name',
    'hybridclaw',
    '--instance-name',
    'lab',
  ]);
  const storeSecret = vi.fn(async () => undefined);
  const fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        ok: true,
        status: 200,
        body: JSON.stringify([
          {
            success: {
              username: 'fresh-application-key',
            },
          },
        ]),
      }),
  }));

  const result = await hue.executeLivePayload(payload, {
    fetch: fetchMock,
    gatewayUrl: 'http://127.0.0.1:9090',
    storeSecret,
    pollDelayMs: 1,
  });

  expect(result).toMatchObject({
    command: 'live-link-result',
    ok: true,
    captured: {
      username: 'HUE_APPLICATION_KEY',
    },
    secretStored: true,
  });
  expect(storeSecret).toHaveBeenCalledWith(
    'HUE_APPLICATION_KEY',
    'fresh-application-key',
  );
  expect(JSON.stringify(result)).not.toContain('fresh-application-key');
});

test('Hue live execution marks unauthorized responses as relink events', async () => {
  const payload = request(['--request', 'http-request', 'lights']);
  const fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        ok: false,
        status: 401,
        body: JSON.stringify({
          errors: [
            {
              type: 'unauthorized_user',
              description: 'invalid application key',
            },
          ],
        }),
      }),
  }));

  const result = await hue.executeLivePayload(payload, {
    fetch: fetchMock,
    gatewayUrl: 'http://127.0.0.1:9090',
  });

  expect(result).toMatchObject({
    stopAfterFirstFailedCall: true,
    event: {
      event: 'hue.bridge_relink_required',
    },
  });
});
