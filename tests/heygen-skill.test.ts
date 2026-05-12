import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { expect, test, vi } from 'vitest';

const helperPath = path.join(process.cwd(), 'skills', 'heygen', 'heygen.cjs');
const skillPath = path.join(process.cwd(), 'skills', 'heygen', 'SKILL.md');
const require = createRequire(import.meta.url);
const heygen = require('../skills/heygen/heygen.cjs');

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
  expect(result.stdout).toContain('--image-url <public-url>');
  expect(result.stdout).toContain('--audio-asset-id <asset-id>');
  expect(result.stdout).toContain('--output-languages <language>');
  expect(result.stdout).toContain('--translate-audio-only');
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

  const payload = heygen.buildRequest([
    'generate-video',
    '--avatar-id',
    'avatar_123',
    '--voice-id',
    'voice_123',
    '--script',
    'Approved script',
    '--operator-grant',
  ]);

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

  const payload = heygen.buildRequest(['list-voices']);

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

test('HeyGen client ignores undocumented WEB_API_TOKEN fallback', async () => {
  const {
    executeHeyGenGatewayRequest,
  } = require('../skills/heygen/client.cjs');
  const previousHybridClawToken = process.env.HYBRIDCLAW_GATEWAY_TOKEN;
  const previousGatewayToken = process.env.GATEWAY_API_TOKEN;
  const previousWebToken = process.env.WEB_API_TOKEN;
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: new Headers(),
    text: async () =>
      JSON.stringify({
        ok: true,
        status: 200,
        headers: {},
        body: '{}',
      }),
  });

  try {
    delete process.env.HYBRIDCLAW_GATEWAY_TOKEN;
    delete process.env.GATEWAY_API_TOKEN;
    process.env.WEB_API_TOKEN = 'legacy-token';

    await executeHeyGenGatewayRequest(
      heygen.buildRequest(['list-avatars']).httpRequest,
      { fetch: fetchMock },
    );
  } finally {
    if (previousHybridClawToken === undefined) {
      delete process.env.HYBRIDCLAW_GATEWAY_TOKEN;
    } else {
      process.env.HYBRIDCLAW_GATEWAY_TOKEN = previousHybridClawToken;
    }
    if (previousGatewayToken === undefined) {
      delete process.env.GATEWAY_API_TOKEN;
    } else {
      process.env.GATEWAY_API_TOKEN = previousGatewayToken;
    }
    if (previousWebToken === undefined) {
      delete process.env.WEB_API_TOKEN;
    } else {
      process.env.WEB_API_TOKEN = previousWebToken;
    }
  }

  expect(fetchMock.mock.calls[0][1].headers).not.toHaveProperty(
    'Authorization',
  );
});

test('HeyGen helper emits gateway-proxied read requests with secret header binding', () => {
  const payload = heygen.buildRequest(['list-avatars']);

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
  expect(JSON.stringify(payload)).not.toContain('api-key-value');
});

test('HeyGen helper plans generate and translate requests as guarded operations', () => {
  const generate = heygen.classifyPlan(
    'Create an avatar video from this approved script',
  );
  const translate = heygen.classifyPlan(
    'Translate this customer training video to German with lip sync',
  );

  expect(generate).toMatchObject({
    operation: 'video-generate',
    stakesTier: 'amber',
    requiredGrant: 'approve-heygen-video-generate',
    brandVoiceGateRequired: true,
  });
  expect(translate).toMatchObject({
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
  const generate = heygen.buildRequest([
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
  const translate = heygen.buildRequest([
    'translate-video',
    '--video-url',
    'https://example.com/source.mp4',
    '--output-language',
    'de',
    '--mode',
    'fast',
    '--operator-grant',
  ]);

  expect(generate.httpRequest).toMatchObject({
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
  expect(translate.httpRequest).toMatchObject({
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
  const ipv6Loopback = runHelper([
    '--format',
    'json',
    'http-request',
    'translate-video',
    '--video-url',
    'http://[::1]/source.mp4',
    '--output-language',
    'de',
    '--operator-grant',
  ]);
  const ipv6MappedLoopback = runHelper([
    '--format',
    'json',
    'http-request',
    'translate-video',
    '--video-url',
    'http://[::ffff:127.0.0.1]/source.mp4',
    '--output-language',
    'de',
    '--operator-grant',
  ]);
  const publicFcHostname = runHelper([
    '--format',
    'json',
    'http-request',
    'translate-video',
    '--video-url',
    'https://fc-example.com/source.mp4',
    '--output-language',
    'de',
    '--operator-grant',
  ]);

  expect(internalUrl.status).not.toBe(0);
  expect(internalUrl.stderr).toContain(
    '--video-url must not target private or internal addresses.',
  );
  expect(ipv6Loopback.status).not.toBe(0);
  expect(ipv6Loopback.stderr).toContain(
    '--video-url must not target private or internal addresses.',
  );
  expect(ipv6MappedLoopback.status).not.toBe(0);
  expect(ipv6MappedLoopback.stderr).toContain(
    '--video-url must not target private or internal addresses.',
  );
  expect(publicFcHostname.status).toBe(0);
  expect(JSON.parse(publicFcHostname.stdout).httpRequest.json).toMatchObject({
    video_url: 'https://fc-example.com/source.mp4',
  });
  expect(apiKeyFlag.status).not.toBe(0);
  expect(apiKeyFlag.stderr).toContain(
    '--api-key is not supported by the HeyGen helper.',
  );
});

test('HeyGen helper classifies rate limits and transient upstream failures', () => {
  const retryAfter = heygen.classifyRateLimit([
    '--status',
    '429',
    '--retry-after',
    '7',
  ]);
  const bodyLimit = heygen.classifyRateLimit([
    '--status',
    '200',
    '--body-json',
    '{"data":{"error":{"message":"Exceed rate limit"}}}',
  ]);
  const serverError = heygen.classifyRateLimit(['--status', '503']);
  const insufficientCredits = heygen.classifyRateLimit([
    '--status',
    '402',
    '--body',
    'Insufficient credits for this request',
  ]);

  expect(retryAfter).toMatchObject({
    rateLimited: true,
    retryable: true,
    retryAfterMs: 7000,
    reason: 'heygen-rate-limit',
  });
  expect(bodyLimit).toMatchObject({
    rateLimited: true,
    shouldBackoff: true,
  });
  expect(serverError).toMatchObject({
    rateLimited: false,
    retryable: true,
    reason: 'heygen-retryable-upstream',
  });
  expect(insufficientCredits).toMatchObject({
    rateLimited: false,
    retryable: false,
    reason: 'heygen-insufficient-credits',
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
