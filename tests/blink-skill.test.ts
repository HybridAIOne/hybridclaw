import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { expect, test, vi } from 'vitest';

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

  expect(manifest.credentials).toEqual(expect.arrayContaining([
    expect.objectContaining({
      id: 'blink-email',
      kind: 'api_key',
      required: true,
      secretRef: { source: 'store', id: 'BLINK_EMAIL' },
    }),
    expect.objectContaining({
      id: 'blink-password',
      kind: 'api_key',
      required: true,
      secretRef: { source: 'store', id: 'BLINK_PASSWORD' },
    }),
    expect.objectContaining({
      id: 'blink-auth-token',
      kind: 'bearer',
      required: false,
      secretRef: { source: 'store', id: 'BLINK_AUTH_TOKEN' },
    }),
    expect.objectContaining({
      id: 'blink-refresh-token',
      kind: 'bearer',
      required: false,
      secretRef: { source: 'store', id: 'BLINK_REFRESH_TOKEN' },
    }),
  ]));
  expect(skill).toContain('category: home-automation');
  expect(skill).toContain('video-doorbell');
  expect(skill).toContain('`BLINK_DEVICE_ID` and `BLINK_CLIENT_NAME` are not secrets');
  expect(skill).toContain('/secret set BLINK_EMAIL');
  expect(skill).toContain('/secret set BLINK_PASSWORD');
  expect(skill).toContain('hybridclaw secret set BLINK_EMAIL');
  expect(skill).toContain('hybridclaw secret set BLINK_PASSWORD');
  expect(skill.indexOf('/secret set BLINK_EMAIL')).toBeLessThan(
    skill.indexOf('hybridclaw secret set BLINK_EMAIL'),
  );
  expect(skill).toContain('Do not ask the operator to set these manually after');
  expect(skill).toContain('rest-<BLINK_TIER>.immedia-semi.com');
  expect(skill).toContain('Use `run` for live Blink calls');
  expect(skill).toContain('generic `http_request` primitives');
  expect(skill).toContain('subject-verb names');
  expect(skill).toContain('captureResponseFields');
  expect(skill).toContain('OAuth v2 Authorization Code + PKCE');
  expect(skill).toContain('Do not run `hybridclaw secret get`');
  expect(skill).toContain('Do not tell the operator all Blink credentials are missing');
  expect(skill).toContain('clips-list` intentionally does not accept `--network`');
  expect(skill).toContain('Stop after the first 401');
  expect(skill).toContain('PIN via F14');
  expect(skill).toContain('approvedHelperCommandText');
  expect(skill).toContain('network-arm');
  expect(skill).toContain('clip-delete');
  expect(skill).toContain('camera-live-view-start');
});

test('Blink helper --help exits cleanly and lists read and guarded commands', () => {
  const result = runHelper(['--help']);

  expect(result.status).toBe(0);
  expect(result.stdout).toContain('Blink skill helper');
  expect(result.stdout).toContain('run account-login');
  expect(result.stdout).toContain('http-request account-login');
  expect(result.stdout).toContain('subject-verb');
  expect(result.stdout).toContain('BLINK_DEVICE_ID');
  expect(result.stdout).toContain('optional generated OAuth v2 hardware id override');
  expect(result.stdout).toContain('BLINK_USER_AGENT');
  expect(result.stdout).toContain('http-request pin-verify --pin <code>');
  expect(result.stdout).toContain('http-request devices-list');
  expect(result.stdout).toContain('http-request camera-config-read');
  expect(result.stdout).toContain('http-request camera-signals-read');
  expect(result.stdout).toContain('clips-list is account-scoped');
  expect(result.stdout).toContain('plan camera-motion-set');
  expect(result.stdout).toContain('plan camera-live-view-start');
});

test('Blink login dry-run returns OAuth v2 helper-run instructions without credentials', () => {
  const payload = request(['http-request', 'account-login']);

  expect(payload).toMatchObject({
    command: 'auth-plan',
    operation: 'account-login',
    stakesTier: 'green',
    liveHelperCommand: [
      'node',
      'skills/blink/blink.cjs',
      '--format',
      'json',
      'run',
      'account-login',
    ],
    flow: {
      type: 'oauth-v2-authorization-code-pkce',
      hosts: ['api.oauth.blink.com', 'rest-prod.immedia-semi.com'],
    },
  });
  expect(payload).not.toHaveProperty('httpRequest');
  expect(payload.toolCallInstructions).toContain(
    'Run the helper with `run account-login` for live auth',
  );
  expect(payload.toolCallInstructions).toContain('grant_type=password');
  expect(payload.result).toContain('OAuth v2 Authorization Code + PKCE');
  expect(JSON.stringify(payload)).not.toContain('<secret:BLINK_EMAIL>');
  expect(JSON.stringify(payload)).not.toContain('<secret:BLINK_PASSWORD>');
  expect(JSON.stringify(payload)).not.toContain('password123');
  expect(JSON.stringify(payload)).not.toContain('auth-token');
  expect(payload).not.toHaveProperty('failurePolicy');
  expect(payload).not.toHaveProperty('secretRefPolicy');
});

test('Blink login dry-run ignores stale env identity flags and rejects unexpected flag values', () => {
  const envResult = runHelper(
    ['--format', 'json', 'http-request', 'account-login'],
    {
      BLINK_DEVICE_ID: 'hybridclaw-env-device',
      BLINK_CLIENT_NAME: 'hybridclaw env',
      BLINK_USER_AGENT: 'BlinkHomeSecurity/99.0 (iPhone; iOS 17.6; Scale/3.00)',
    },
  );
  const flagResult = runHelper([
    '--format',
    'json',
    'http-request',
    'account-login',
    '--device-id',
    'hybridclaw-flag-device',
    '--client-name',
    'hybridclaw flag',
  ]);

  expect(envResult.status).toBe(0);
  expect(JSON.parse(envResult.stdout)).toMatchObject({
    command: 'auth-plan',
    operation: 'account-login',
  });
  expect(flagResult.status).not.toBe(0);
  expect(flagResult.stderr).toContain('Unexpected argument: --device-id');
  expect(flagResult.stderr).not.toContain('hybridclaw-flag-device');
});

test('Blink helper runs OAuth v2 login through gateway and captures secrets', async () => {
  const seenRequests: Array<Record<string, unknown>> = [];
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    const requestBody = JSON.parse(String(init.body));
    seenRequests.push(requestBody);
    const targetUrl = String(requestBody.url);
    if (targetUrl.includes('/oauth/v2/authorize') && seenRequests.length === 1) {
      return new Response(
        JSON.stringify({
          ok: true,
          status: 200,
          headers: { 'set-cookie': 'oauth=one; Path=/; Secure' },
          body: '<html></html>',
        }),
      );
    }
    if (targetUrl === 'https://api.oauth.blink.com/oauth/v2/signin') {
      if (requestBody.method === 'GET') {
        return new Response(
          JSON.stringify({
            ok: true,
            status: 200,
            headers: { 'set-cookie': 'signin=two; Path=/; Secure' },
            body: '<script id="oauth-args" type="application/json">{"csrf-token":"csrf-123"}</script>',
          }),
        );
      }
      return new Response(
        JSON.stringify({
          ok: false,
          status: 302,
          statusText: 'Found',
          headers: { 'set-cookie': 'signed=three; Path=/; Secure' },
          body: '',
        }),
      );
    }
    if (targetUrl.includes('/oauth/v2/authorize')) {
      return new Response(
        JSON.stringify({
          ok: false,
          status: 302,
          statusText: 'Found',
          headers: {
            location:
              'immedia-blink://applinks.blink.com/signin/callback?code=code-123',
          },
          body: '',
        }),
      );
    }
    if (targetUrl === 'https://api.oauth.blink.com/oauth/token') {
      return new Response(
        JSON.stringify({
          ok: true,
          status: 200,
          captured: {
            access_token: 'BLINK_AUTH_TOKEN',
            refresh_token: 'BLINK_REFRESH_TOKEN',
          },
        }),
      );
    }
    if (targetUrl === 'https://rest-prod.immedia-semi.com/api/v1/users/tier_info') {
      return new Response(
        JSON.stringify({
          ok: true,
          status: 200,
          captured: {
            tier: 'BLINK_TIER',
            account_id: 'BLINK_ACCOUNT_ID',
            client_id: 'BLINK_CLIENT_ID',
          },
        }),
      );
    }
    throw new Error(`unexpected request to ${targetUrl}`);
  });

  const result = await blink.runAccountLogin([], {
    fetch: fetchMock,
    gatewayUrl: 'http://127.0.0.1:9090',
    gatewayToken: 'gateway-token',
  });

  expect(result).toMatchObject({
    command: 'live-auth',
    operation: 'account-login',
    result: {
      ok: true,
      tokenCaptured: {
        access_token: 'BLINK_AUTH_TOKEN',
        refresh_token: 'BLINK_REFRESH_TOKEN',
      },
      tierCaptured: {
        tier: 'BLINK_TIER',
        account_id: 'BLINK_ACCOUNT_ID',
      },
    },
  });
  expect(fetchMock).toHaveBeenCalledTimes(6);
  expect(seenRequests[0]).toMatchObject({
    allowManualRedirect: true,
    includeResponseCookies: true,
    skillName: 'blink',
  });
  expect(String(seenRequests[0].url)).toContain('/oauth/v2/authorize');
  expect(String(seenRequests[0].url)).toContain('code_challenge_method=S256');
  expect(seenRequests[2]).toMatchObject({
    method: 'POST',
    allowManualRedirect: true,
    form: {
      username: '<secret:BLINK_EMAIL>',
      password: '<secret:BLINK_PASSWORD>',
      'csrf-token': 'csrf-123',
    },
  });
  expect(seenRequests[2]).not.toHaveProperty('body');
  expect(seenRequests[3]).toMatchObject({
    url: 'https://api.oauth.blink.com/oauth/v2/authorize',
    headers: expect.objectContaining({
      Accept: '*/*',
      Referer: 'https://api.oauth.blink.com/oauth/v2/signin',
    }),
  });
  expect(seenRequests[4]).toMatchObject({
    url: 'https://api.oauth.blink.com/oauth/token',
    method: 'POST',
    captureResponseFields: [
      {
        jsonPath: 'access_token',
        secretName: 'BLINK_AUTH_TOKEN',
        bindDomain: 'immedia-semi.com',
      },
      {
        jsonPath: 'refresh_token',
        secretName: 'BLINK_REFRESH_TOKEN',
        bindDomain: 'api.oauth.blink.com',
      },
    ],
  });
  expect(seenRequests[5]).toMatchObject({
    url: 'https://rest-prod.immedia-semi.com/api/v1/users/tier_info',
    secretHeaders: [
      {
        name: 'TOKEN_AUTH',
        secretName: 'BLINK_AUTH_TOKEN',
        prefix: 'none',
      },
    ],
  });
  expect(JSON.stringify(seenRequests)).not.toContain('password123');
});

test('Blink helper stops OAuth login for F14 PIN handover when 2FA is required', async () => {
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    const requestBody = JSON.parse(String(init.body));
    const targetUrl = String(requestBody.url);
    if (targetUrl.includes('/oauth/v2/authorize')) {
      return new Response(
        JSON.stringify({
          ok: true,
          status: 200,
          headers: { 'set-cookie': 'oauth=one; Path=/; Secure' },
          body: '',
        }),
      );
    }
    if (targetUrl === 'https://api.oauth.blink.com/oauth/v2/signin') {
      if (requestBody.method === 'GET') {
        return new Response(
          JSON.stringify({
            ok: true,
            status: 200,
            headers: {},
            body: '<script id="oauth-args" type="application/json">{"csrf-token":"csrf-123"}</script>',
          }),
        );
      }
      return new Response(
        JSON.stringify({
          ok: false,
          status: 412,
          statusText: 'Precondition Failed',
          headers: {},
          body: '',
        }),
      );
    }
    throw new Error(`unexpected request to ${targetUrl}`);
  });

  const result = await blink.runAccountLogin([], {
    fetch: fetchMock,
    gatewayUrl: 'http://127.0.0.1:9090',
  });

  expect(result).toMatchObject({
    command: 'handover-required',
    route: 'f14',
    reason: 'blink-2fa-required',
  });
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

test('Blink helper stops OAuth login when stored credentials are rejected', async () => {
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    const requestBody = JSON.parse(String(init.body));
    const targetUrl = String(requestBody.url);
    if (targetUrl.includes('/oauth/v2/authorize')) {
      return new Response(
        JSON.stringify({
          ok: true,
          status: 200,
          headers: { 'set-cookie': 'oauth=one; Path=/; Secure' },
          body: '',
        }),
      );
    }
    if (targetUrl === 'https://api.oauth.blink.com/oauth/v2/signin') {
      if (requestBody.method === 'GET') {
        return new Response(
          JSON.stringify({
            ok: true,
            status: 200,
            headers: {},
            body: '<script id="oauth-args" type="application/json">{"csrf-token":"csrf-123"}</script>',
          }),
        );
      }
      return new Response(
        JSON.stringify({
          ok: false,
          status: 401,
          statusText: 'Unauthorized',
          headers: {},
          body: JSON.stringify({
            error: 'unauthorized',
            error_cause: 'invalid_user_credentials',
          }),
        }),
      );
    }
    throw new Error(`unexpected request to ${targetUrl}`);
  });

  const result = await blink.runAccountLogin([], {
    fetch: fetchMock,
    gatewayUrl: 'http://127.0.0.1:9090',
  });

  expect(result).toMatchObject({
    command: 'auth-stopped',
    operation: 'account-login',
    ok: false,
    reason: 'blink-invalid-credentials',
    setupCommands: [
      '/secret set BLINK_EMAIL "<account email>"',
      '/secret set BLINK_PASSWORD "<account password>"',
    ],
  });
  expect(JSON.stringify(result)).not.toContain('hybridclaw secret set');
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

test('Blink helper stops OAuth login while Blink rate limit is active', async () => {
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    const requestBody = JSON.parse(String(init.body));
    const targetUrl = String(requestBody.url);
    if (targetUrl.includes('/oauth/v2/authorize')) {
      return new Response(
        JSON.stringify({
          ok: true,
          status: 200,
          headers: { 'set-cookie': 'oauth=one; Path=/; Secure' },
          body: '',
        }),
      );
    }
    if (targetUrl === 'https://api.oauth.blink.com/oauth/v2/signin') {
      if (requestBody.method === 'GET') {
        return new Response(
          JSON.stringify({
            ok: true,
            status: 200,
            headers: {},
            body: '<script id="oauth-args" type="application/json">{"csrf-token":"csrf-123"}</script>',
          }),
        );
      }
      return new Response(
        JSON.stringify({
          ok: false,
          status: 429,
          statusText: 'Too Many Requests',
          headers: {},
          body: JSON.stringify({
            error: 'too_many_requests',
            error_cause: 'too_many_invalid_request',
            next_time_in_secs: 600,
          }),
        }),
      );
    }
    throw new Error(`unexpected request to ${targetUrl}`);
  });

  const result = await blink.runAccountLogin([], {
    fetch: fetchMock,
    gatewayUrl: 'http://127.0.0.1:9090',
  });

  expect(result).toMatchObject({
    command: 'auth-stopped',
    operation: 'account-login',
    ok: false,
    reason: 'blink-rate-limited',
    retryAfterSeconds: 600,
  });
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

test('Blink live read routes missing session secrets to account-login instead of asking for all credentials', async () => {
  const payload = request(['http-request', 'devices-list']);
  const result = await blink.executeLivePayload(payload, {
    fetch: vi.fn(async () =>
      new Response(
        JSON.stringify({ error: 'Stored secret BLINK_TIER is not set.' }),
        { status: 400 },
      ),
    ),
    gatewayUrl: 'http://127.0.0.1:9090',
  });

  expect(result).toMatchObject({
    command: 'auth-required',
    operation: 'devices-list',
    ok: false,
    reason: 'blink-login-required',
    missingSecret: 'BLINK_TIER',
    nextCommand: 'node skills/blink/blink.cjs --format json run account-login',
  });
  expect(result.result).toContain('email/password can already be stored');
});

test('Blink login reports missing primary credentials with TUI slash commands', async () => {
  const result = await blink.runAccountLogin([], {
    fetch: vi.fn(async () =>
      new Response(
        JSON.stringify({ error: 'Stored secret BLINK_EMAIL is not set.' }),
        { status: 400 },
      ),
    ),
    gatewayUrl: 'http://127.0.0.1:9090',
  });

  expect(result).toMatchObject({
    command: 'credentials-required',
    operation: 'account-login',
    ok: false,
    reason: 'blink-primary-credentials-required',
    missingSecret: 'BLINK_EMAIL',
    setupCommands: [
      '/secret set BLINK_EMAIL "<account email>"',
      '/secret set BLINK_PASSWORD "<account password>"',
    ],
  });
  expect(JSON.stringify(result)).not.toContain('hybridclaw secret set');
});

test('Blink helper accepts legacy operation aliases but emits canonical subject-verb operations', () => {
  const legacyLogin = request(['http-request', 'login']);
  const legacyHomescreen = request(['http-request', 'homescreen']);
  const legacyPlan = request([
    'plan',
    'camera-motion',
    '--network',
    '111',
    '--camera',
    '222',
    '--enable',
    'false',
  ]);

  expect(legacyLogin.operation).toBe('account-login');
  expect(legacyHomescreen.operation).toBe('devices-list');
  expect(legacyPlan.operation).toBe('camera-motion-set');
});

test('Blink helper builds PIN handover and tier-pinned read requests', () => {
  const verifyPin = request(['http-request', 'pin-verify', '--pin', '123456']);
  const devices = request(['http-request', 'devices-list']);
  const cameras = request(['http-request', 'cameras-list', '--network', '111']);
  const cameraConfig = request([
    'http-request',
    'camera-config-read',
    '--network',
    '111',
    '--camera',
    '222',
  ]);
  const cameraSignals = request([
    'http-request',
    'camera-signals-read',
    '--network',
    '111',
    '--camera',
    '222',
  ]);
  const clips = request([
    'http-request',
    'clips-list',
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
    operation: 'pin-verify',
    stakesTier: 'amber',
    httpRequest: {
      url: 'https://rest-<secret:BLINK_TIER>.immedia-semi.com/api/v4/account/<secret:BLINK_ACCOUNT_ID>/client/<secret:BLINK_CLIENT_ID>/pin/verify',
      method: 'POST',
      json: { pin: '123456' },
    },
  });
  expect(devices.httpRequest.url).toBe(
    'https://rest-<secret:BLINK_TIER>.immedia-semi.com/api/v3/accounts/<secret:BLINK_ACCOUNT_ID>/homescreen',
  );
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
  expect(clips.httpRequest.headers).not.toHaveProperty('TOKEN_AUTH');
  expect(clips.httpRequest.secretHeaders).toEqual([
    {
      name: 'TOKEN_AUTH',
      secretName: 'BLINK_AUTH_TOKEN',
      prefix: 'none',
    },
  ]);
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
  const ignoredNetwork = runHelper([
    '--format',
    'json',
    'http-request',
    'clips-list',
    '--network',
    '111',
  ]);

  expect(arbitrary.status).not.toBe(0);
  expect(arbitrary.stderr).toContain(
    'Unsupported Blink http-request operation',
  );
  expect(traversal.status).not.toBe(0);
  expect(traversal.stderr).toContain('--path must be a Blink media path');
  expect(ignoredNetwork.status).not.toBe(0);
  expect(ignoredNetwork.stderr).toContain('Unexpected argument: --network');
});

test('Blink helper builds exact approval plans for privacy-sensitive operations', () => {
  const plan = request([
    'plan',
    'camera-motion-set',
    '--network',
    '111',
    '--camera',
    '222',
    '--enable',
    'false',
  ]);

  expect(plan).toMatchObject({
    command: 'approval-plan',
    operation: 'camera-motion-set',
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
  expect(plan.httpRequest.headers).not.toHaveProperty('TOKEN_AUTH');
  expect(plan.httpRequest.secretHeaders).toEqual([
    {
      name: 'TOKEN_AUTH',
      secretName: 'BLINK_AUTH_TOKEN',
      prefix: 'none',
    },
  ]);
});

test('Blink helper requires operator grant for mutating http-request commands', () => {
  const rejected = runHelper([
    '--format',
    'json',
    'http-request',
    'network-arm',
    '--network',
    '111',
  ]);
  const approved = runHelper([
    '--format',
    'json',
    'http-request',
    'network-arm',
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
    operation: 'network-arm',
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
    'camera-live-view-start',
    '--network',
    '111',
    '--camera',
    '222',
    '--camera-type',
    'doorbell',
  ]);
  const deleteClip = request(['plan', 'clip-delete', '--clip', 'abc123']);

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
