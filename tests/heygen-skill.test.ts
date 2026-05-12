import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { expect, test, vi } from 'vitest';

const helperPath = path.join(process.cwd(), 'skills', 'heygen', 'heygen.cjs');
const skillPath = path.join(process.cwd(), 'skills', 'heygen', 'SKILL.md');
const require = createRequire(import.meta.url);

function runHelper(args: string[]) {
  return spawnSync('node', [helperPath, ...args], {
    encoding: 'utf-8',
  });
}

test('HeyGen skill manifest declares credential and safety metadata', () => {
  const skill = fs.readFileSync(skillPath, 'utf-8');

  expect(skill).toContain('name: heygen');
  expect(skill).toContain('category: marketing');
  expect(skill).toContain('issue: 831');
  expect(skill).toContain('sub_issue: 874');
  expect(skill).toContain('HEYGEN_API_KEY');
  expect(skill).toContain('source: store');
  expect(skill).toContain('X-API-KEY');
  expect(skill).toContain('stakes_tiers:');
  expect(skill).toContain('public-auto-publish');
  expect(skill).toContain('UsageTotals');
});

test('HeyGen helper --help exits cleanly without exposing auth escape hatches', () => {
  const result = runHelper(['--help']);

  expect(result.status).toBe(0);
  expect(result.stdout).toContain('HeyGen skill helper');
  expect(result.stdout).toContain('list-avatars');
  expect(result.stdout).toContain('generate-video');
  expect(result.stdout).toContain('request <operation>');
  expect(result.stdout).toContain('classify-rate-limit');
  expect(result.stdout).not.toContain('--api-key ');
  expect(result.stdout).not.toContain('--api-key-secret');
});

test('HeyGen client executes through gateway secret injection and normalizes ids', async () => {
  const {
    executeHeyGenGatewayRequest,
  } = require('../skills/heygen/client.cjs');
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: new Headers(),
    text: async () =>
      JSON.stringify({
        ok: true,
        status: 200,
        headers: {},
        body: JSON.stringify({ data: { video_id: 'video_123' } }),
      }),
  });

  const payload = JSON.parse(
    runHelper([
      '--format',
      'json',
      'http-request',
      'generate-video',
      '--avatar-id',
      'avatar_123',
      '--voice-id',
      'voice_123',
      '--script',
      'Approved script',
      '--operator-grant',
    ]).stdout,
  );

  const result = await executeHeyGenGatewayRequest(payload.httpRequest, {
    gatewayUrl: 'http://127.0.0.1:9090',
    gatewayToken: 'gateway-token',
    fetch: fetchMock,
  });

  expect(result.videoId).toBe('video_123');
  expect(fetchMock).toHaveBeenCalledWith(
    'http://127.0.0.1:9090/api/http/request',
    expect.objectContaining({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer gateway-token',
      },
    }),
  );
  const body = JSON.parse(fetchMock.mock.calls[0][1].body);
  expect(body.secretHeaders).toEqual([
    { name: 'X-API-KEY', secretName: 'HEYGEN_API_KEY', prefix: '' },
  ]);
  expect(JSON.stringify(body)).not.toContain('api-key-value');
});

test('HeyGen client retries 429 responses with Retry-After before succeeding', async () => {
  const {
    executeHeyGenGatewayRequest,
  } = require('../skills/heygen/client.cjs');
  const sleeps: number[] = [];
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () =>
        JSON.stringify({
          ok: false,
          status: 429,
          statusText: 'Too Many Requests',
          headers: { 'retry-after': '4' },
          body: '{"message":"Too Many Requests"}',
        }),
    })
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () =>
        JSON.stringify({
          ok: true,
          status: 200,
          headers: {},
          body: JSON.stringify({ data: { video_translate_id: 'vt_123' } }),
        }),
    });

  const payload = JSON.parse(
    runHelper(['--format', 'json', 'http-request', 'list-voices']).stdout,
  );

  const result = await executeHeyGenGatewayRequest(payload.httpRequest, {
    fetch: fetchMock,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
  });

  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(sleeps).toEqual([4000]);
  expect(result.videoTranslateId).toBe('vt_123');
});

test('HeyGen client fails closed for requests missing F13 secret binding', async () => {
  const {
    executeHeyGenGatewayRequest,
    HeyGenApiError,
  } = require('../skills/heygen/client.cjs');

  await expect(
    executeHeyGenGatewayRequest({
      url: 'https://api.heygen.com/v2/avatars',
      method: 'GET',
    }),
  ).rejects.toBeInstanceOf(HeyGenApiError);
});

test('HeyGen helper emits gateway-proxied read requests with secret header binding', () => {
  const result = runHelper([
    '--format',
    'json',
    'http-request',
    'list-avatars',
  ]);

  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout);
  expect(payload.httpRequest).toMatchObject({
    method: 'GET',
    url: 'https://api.heygen.com/v2/avatars',
    skillName: 'heygen',
    secretHeaders: [
      {
        name: 'X-API-KEY',
        secretName: 'HEYGEN_API_KEY',
        prefix: '',
      },
    ],
  });
  expect(payload.costMeasurement.system).toBe('UsageTotals');
  expect(payload.rateLimit.retryableStatuses).toContain(429);
  expect(result.stdout).not.toContain('api-key-value');
});

test('HeyGen helper plans generate and translate requests as guarded operations', () => {
  const generate = runHelper([
    '--format',
    'json',
    'plan',
    'Create an avatar video from this approved script',
  ]);
  const translate = runHelper([
    '--format',
    'json',
    'plan',
    'Translate this customer training video to German with lip sync',
  ]);

  expect(generate.status).toBe(0);
  expect(translate.status).toBe(0);
  expect(JSON.parse(generate.stdout)).toMatchObject({
    operation: 'video-generate',
    stakesTier: 'amber',
    requiredGrant: 'approve-heygen-video-generate',
    brandVoiceGateRequired: true,
  });
  expect(JSON.parse(translate.stdout)).toMatchObject({
    operation: 'video-translate',
    stakesTier: 'amber',
    requiredGrant: 'approve-heygen-video-translate',
  });
});

test('HeyGen helper requires operator grants for credit-consuming requests', () => {
  const result = runHelper([
    '--format',
    'json',
    'http-request',
    'generate-video',
    '--avatar-id',
    'avatar_123',
    '--voice-id',
    'voice_123',
    '--script',
    'Approved script',
  ]);

  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain(
    'Refusing HeyGen video-generate request without --operator-grant',
  );
});

test('HeyGen helper emits generate and translate payloads with validated bodies', () => {
  const generate = runHelper([
    '--format',
    'json',
    'http-request',
    'generate-video',
    '--avatar-id',
    'avatar_123',
    '--voice-id',
    'voice_123',
    '--script',
    'Approved script',
    '--title',
    'Enablement video',
    '--resolution',
    '1080p',
    '--aspect-ratio',
    '16:9',
    '--operator-grant',
  ]);
  const translate = runHelper([
    '--format',
    'json',
    'http-request',
    'translate-video',
    '--video-url',
    'https://example.com/source.mp4',
    '--output-language',
    'de',
    '--mode',
    'fast',
    '--operator-grant',
  ]);

  expect(generate.status).toBe(0);
  expect(translate.status).toBe(0);
  expect(JSON.parse(generate.stdout).httpRequest).toMatchObject({
    method: 'POST',
    url: 'https://api.heygen.com/v2/videos',
    json: {
      avatar_id: 'avatar_123',
      voice_id: 'voice_123',
      script: 'Approved script',
      title: 'Enablement video',
      resolution: '1080p',
      aspect_ratio: '16:9',
    },
  });
  expect(JSON.parse(translate.stdout).httpRequest).toMatchObject({
    method: 'POST',
    url: 'https://api.heygen.com/v2/video_translate',
    json: {
      video_url: 'https://example.com/source.mp4',
      output_language: 'de',
      mode: 'fast',
    },
  });
});

test('HeyGen helper blocks internal media URLs and removed API-key flags', () => {
  const internalUrl = runHelper([
    '--format',
    'json',
    'http-request',
    'translate-video',
    '--video-url',
    'http://127.0.0.1/source.mp4',
    '--output-language',
    'de',
    '--operator-grant',
  ]);
  const apiKeyFlag = runHelper([
    '--format',
    'json',
    'http-request',
    'list-voices',
    '--api-key',
    'api-key-value',
  ]);

  expect(internalUrl.status).not.toBe(0);
  expect(internalUrl.stderr).toContain(
    '--video-url must not target private or internal addresses.',
  );
  expect(apiKeyFlag.status).not.toBe(0);
  expect(apiKeyFlag.stderr).toContain(
    '--api-key is not supported by the HeyGen helper.',
  );
});

test('HeyGen helper classifies rate limits and transient upstream failures', () => {
  const retryAfter = runHelper([
    '--format',
    'json',
    'classify-rate-limit',
    '--status',
    '429',
    '--retry-after',
    '7',
  ]);
  const bodyLimit = runHelper([
    '--format',
    'json',
    'classify-rate-limit',
    '--status',
    '200',
    '--body-json',
    '{"data":{"error":{"message":"Exceed rate limit"}}}',
  ]);
  const serverError = runHelper([
    '--format',
    'json',
    'classify-rate-limit',
    '--status',
    '503',
  ]);

  expect(retryAfter.status).toBe(0);
  expect(bodyLimit.status).toBe(0);
  expect(serverError.status).toBe(0);
  expect(JSON.parse(retryAfter.stdout)).toMatchObject({
    rateLimited: true,
    retryable: true,
    retryAfterMs: 7000,
    reason: 'heygen-rate-limit',
  });
  expect(JSON.parse(bodyLimit.stdout)).toMatchObject({
    rateLimited: true,
    shouldBackoff: true,
  });
  expect(JSON.parse(serverError.stdout)).toMatchObject({
    rateLimited: false,
    retryable: true,
    reason: 'heygen-retryable-upstream',
  });
});

test('HeyGen helper eval suite covers adapter contracts', () => {
  const result = runHelper(['--format', 'json', 'eval-scenarios']);

  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    scenarioCount: 3,
    failed: 0,
    categories: {
      read: 1,
      planning: 1,
      'rate-limit': 1,
    },
  });
});
