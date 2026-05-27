import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { expect, test } from 'vitest';

import { parseSkillManifestFromMarkdown } from '../src/skills/skill-manifest.js';

const helperPath = path.join(process.cwd(), 'skills', 'blink', 'blink.cjs');
const skillPath = path.join(process.cwd(), 'skills', 'blink', 'SKILL.md');
const require = createRequire(import.meta.url);
const blink = require('../skills/blink/blink.cjs');

function runHelper(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync('node', [helperPath, ...args], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      BLINK_TIER: 'e003',
      BLINK_ACCOUNT_ID: '1234',
      BLINK_CLIENT_ID: '5678',
      ...env,
    },
  });
}

function request(args: string[]) {
  return blink.buildRequest(['--format', 'json', ...args]);
}

test('Blink skill manifest declares SecretRef credentials and guarded operations', () => {
  const skill = fs.readFileSync(skillPath, 'utf-8');
  const manifest = parseSkillManifestFromMarkdown(skill, { name: 'blink' });

  expect(manifest.credentials).toMatchObject([
    {
      id: 'blink-email',
      kind: 'api_key',
      required: true,
      secretRef: { source: 'store', id: 'BLINK_EMAIL' },
    },
    {
      id: 'blink-password',
      kind: 'api_key',
      required: true,
      secretRef: { source: 'store', id: 'BLINK_PASSWORD' },
    },
    {
      id: 'blink-device-id',
      kind: 'api_key',
      required: true,
      secretRef: { source: 'store', id: 'BLINK_DEVICE_ID' },
    },
    {
      id: 'blink-client-name',
      kind: 'api_key',
      required: true,
      secretRef: { source: 'store', id: 'BLINK_CLIENT_NAME' },
    },
    {
      id: 'blink-auth-token',
      kind: 'bearer',
      required: false,
      secretRef: { source: 'store', id: 'BLINK_AUTH_TOKEN' },
    },
  ]);
  expect(skill).toContain('category: home-automation');
  expect(skill).toContain('video-doorbell');
  expect(skill).toContain('rest-<BLINK_TIER>.immedia-semi.com');
  expect(skill).toContain(
    'Use the emitted `httpRequest` object with the gateway `http_request` tool.',
  );
  expect(skill).toContain('F14 PIN');
  expect(skill).toContain('approvedHelperCommandText');
  expect(skill).toContain('arm-network');
  expect(skill).toContain('delete-clip');
  expect(skill).toContain('live-view');
});

test('Blink helper --help exits cleanly and lists read and guarded commands', () => {
  const result = runHelper(['--help']);

  expect(result.status).toBe(0);
  expect(result.stdout).toContain('Blink skill helper');
  expect(result.stdout).toContain('http-request login');
  expect(result.stdout).toContain('http-request verify-pin --pin <code>');
  expect(result.stdout).toContain('http-request camera-config');
  expect(result.stdout).toContain('http-request camera-signals');
  expect(result.stdout).toContain('plan camera-motion');
  expect(result.stdout).toContain('plan live-view');
});

test('Blink login request captures token and tier without emitting cleartext credentials', () => {
  const payload = request(['http-request', 'login']);

  expect(payload).toMatchObject({
    command: 'http-request',
    operation: 'login',
    stakesTier: 'green',
    httpRequest: {
      url: 'https://rest-prod.immedia-semi.com/api/v5/account/login',
      method: 'POST',
      replaceSecretPlaceholders: true,
      skillName: 'blink',
      json: {
        email: '<secret:BLINK_EMAIL>',
        password: '<secret:BLINK_PASSWORD>',
        unique_id: '<secret:BLINK_DEVICE_ID>',
        client_name: '<secret:BLINK_CLIENT_NAME>',
        reauth: 'true',
      },
      captureResponseFields: [
        { jsonPath: 'auth.token', secretName: 'BLINK_AUTH_TOKEN' },
        { jsonPath: 'account.tier', secretName: 'BLINK_TIER' },
        { jsonPath: 'account.account_id', secretName: 'BLINK_ACCOUNT_ID' },
        { jsonPath: 'account.client_id', secretName: 'BLINK_CLIENT_ID' },
      ],
    },
    handover: {
      route: 'f14',
    },
    responseHandling: {
      authStopStatuses: [401, 412],
      capturePersistsSecrets: [
        'BLINK_AUTH_TOKEN',
        'BLINK_TIER',
        'BLINK_ACCOUNT_ID',
        'BLINK_CLIENT_ID',
      ],
    },
  });
  expect(JSON.stringify(payload)).not.toContain('password123');
  expect(JSON.stringify(payload)).not.toContain('auth-token');
  expect(payload.failurePolicy).toContain('Stop after the first 401');
});

test('Blink helper builds PIN handover and tier-pinned read requests', () => {
  const verifyPin = request(['http-request', 'verify-pin', '--pin', '123456']);
  const cameras = request(['http-request', 'cameras', '--network', '111']);
  const cameraConfig = request([
    'http-request',
    'camera-config',
    '--network',
    '111',
    '--camera',
    '222',
  ]);
  const cameraSignals = request([
    'http-request',
    'camera-signals',
    '--network',
    '111',
    '--camera',
    '222',
  ]);
  const clips = request([
    'http-request',
    'clips',
    '--since',
    '2026-05-26T00:00:00Z',
    '--page',
    '2',
    '--max',
    '25',
  ]);
  const download = request([
    'http-request',
    'clip-download',
    '--path',
    '/api/v2/accounts/<secret:BLINK_ACCOUNT_ID>/media/clip/2026/05/26/front.mp4',
  ]);

  expect(verifyPin).toMatchObject({
    operation: 'verify-pin',
    stakesTier: 'amber',
    httpRequest: {
      url: 'https://rest-<secret:BLINK_TIER>.immedia-semi.com/api/v4/account/<secret:BLINK_ACCOUNT_ID>/client/<secret:BLINK_CLIENT_ID>/pin/verify',
      method: 'POST',
      json: { pin: '123456' },
    },
  });
  expect(cameras.httpRequest.url).toBe(
    'https://rest-<secret:BLINK_TIER>.immedia-semi.com/network/111/cameras',
  );
  expect(cameraConfig.httpRequest.url).toBe(
    'https://rest-<secret:BLINK_TIER>.immedia-semi.com/network/111/camera/222/config',
  );
  expect(cameraSignals.httpRequest.url).toBe(
    'https://rest-<secret:BLINK_TIER>.immedia-semi.com/network/111/camera/222/signals',
  );
  expect(clips.httpRequest.url).toBe(
    'https://rest-<secret:BLINK_TIER>.immedia-semi.com/api/v1/accounts/<secret:BLINK_ACCOUNT_ID>/media/changed?since=2026-05-26T00%3A00%3A00Z&page=2',
  );
  expect(clips.artifact).toMatchObject({
    mode: 'metadata-only',
    maxItems: 25,
  });
  expect(clips.httpRequest.headers.TOKEN_AUTH).toBe(
    '<secret:BLINK_AUTH_TOKEN>',
  );
  expect(download).toMatchObject({
    operation: 'clip-download',
    artifact: {
      mode: 'gateway-artifact',
      maxInlineBytes: 0,
    },
    httpRequest: {
      url: 'https://prod.immedia-semi.com/api/v2/accounts/<secret:BLINK_ACCOUNT_ID>/media/clip/2026/05/26/front.mp4',
      suppressResponseBody: true,
    },
  });
});

test('Blink helper rejects arbitrary endpoint passthrough and unsafe clip paths', () => {
  const arbitrary = runHelper([
    '--format',
    'json',
    'http-request',
    'https://evil.example.com/steal',
  ]);
  const traversal = runHelper([
    '--format',
    'json',
    'http-request',
    'clip-download',
    '--path',
    '/api/v2/accounts/1234/media/clip/../../secret.mp4',
  ]);

  expect(arbitrary.status).not.toBe(0);
  expect(arbitrary.stderr).toContain(
    'Unsupported Blink http-request operation',
  );
  expect(traversal.status).not.toBe(0);
  expect(traversal.stderr).toContain('--path must be a Blink media path');
});

test('Blink helper builds exact approval plans for privacy-sensitive operations', () => {
  const plan = request([
    'plan',
    'camera-motion',
    '--network',
    '111',
    '--camera',
    '222',
    '--enable',
    'false',
  ]);

  expect(plan).toMatchObject({
    command: 'approval-plan',
    operation: 'camera-motion',
    stakesTier: 'amber',
    approvalRequired: true,
    approvalRoute: 'f14',
    target: {
      host: 'rest-<secret:BLINK_TIER>.immedia-semi.com',
      path: '/network/111/camera/222/disable',
      method: 'POST',
    },
  });
  expect(plan.approvalText).toContain('disable Blink camera motion detection');
  expect(plan.approvalText).toContain('Network: 111.');
  expect(plan.approvalText).toContain('Camera: 222.');
  expect(plan.approvedHelperCommandText).toContain('--operator-grant');
  expect(plan.httpRequest.headers.TOKEN_AUTH).toBe('<secret:BLINK_AUTH_TOKEN>');
});

test('Blink helper requires operator grant for mutating http-request commands', () => {
  const rejected = runHelper([
    '--format',
    'json',
    'http-request',
    'arm-network',
    '--network',
    '111',
  ]);
  const approved = runHelper([
    '--format',
    'json',
    'http-request',
    'arm-network',
    '--network',
    '111',
    '--operator-grant',
  ]);

  expect(rejected.status).not.toBe(0);
  expect(rejected.stderr).toContain(
    'pass --operator-grant only after exact F8/F14 operator approval',
  );
  expect(approved.status).toBe(0);
  expect(JSON.parse(approved.stdout)).toMatchObject({
    operation: 'arm-network',
    stakesTier: 'amber',
    httpRequest: {
      url: 'https://rest-e003.immedia-semi.com/api/v1/accounts/1234/networks/111/state/arm',
      method: 'POST',
    },
  });
});

test('Blink helper shapes red live-view and delete plans', () => {
  const liveView = request([
    'plan',
    'live-view',
    '--network',
    '111',
    '--camera',
    '222',
    '--camera-type',
    'doorbell',
  ]);
  const deleteClip = request(['plan', 'delete-clip', '--clip', 'abc123']);

  expect(liveView).toMatchObject({
    stakesTier: 'red',
    target: {
      path: '/api/v1/accounts/<secret:BLINK_ACCOUNT_ID>/networks/111/doorbells/222/liveview',
    },
    json: { intent: 'liveview' },
    httpRequest: {
      suppressResponseBody: true,
    },
    responseHandling: {
      opaqueResult: true,
      allowedSurface: 'operator-facing UI only',
    },
  });
  expect(deleteClip).toMatchObject({
    stakesTier: 'red',
    target: {
      path: '/api/v1/accounts/<secret:BLINK_ACCOUNT_ID>/media/delete',
    },
    json: { media: ['abc123'] },
  });
});
