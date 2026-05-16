import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const helperPath = path.join(
  process.cwd(),
  'skills',
  'video.from-script',
  'video-from-script.cjs',
);
const skillPath = path.join(
  process.cwd(),
  'skills',
  'video.from-script',
  'SKILL.md',
);
const require = createRequire(import.meta.url);
const videoFromScript = require('../skills/video.from-script/video-from-script.cjs');

const ORIGINAL_WORKSPACE_ROOT = process.env.HYBRIDCLAW_AGENT_WORKSPACE_ROOT;
const ORIGINAL_WORKSPACE_DISPLAY_ROOT =
  process.env.HYBRIDCLAW_AGENT_WORKSPACE_DISPLAY_ROOT;
const ORIGINAL_HEYGEN_ASSET_CACHE_DIR = process.env.HEYGEN_ASSET_CACHE_DIR;

let workspaceRoot = '';

function runHelper(args: string[]) {
  return spawnSync('node', [helperPath, ...args], {
    encoding: 'utf-8',
  });
}

beforeEach(() => {
  workspaceRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-video-from-script-'),
  );
  process.env.HYBRIDCLAW_AGENT_WORKSPACE_ROOT = workspaceRoot;
  process.env.HYBRIDCLAW_AGENT_WORKSPACE_DISPLAY_ROOT = '/workspace';
  process.env.HEYGEN_ASSET_CACHE_DIR = path.join(
    workspaceRoot,
    '.heygen-cache',
  );
});

afterEach(() => {
  if (ORIGINAL_WORKSPACE_ROOT == null) {
    delete process.env.HYBRIDCLAW_AGENT_WORKSPACE_ROOT;
  } else {
    process.env.HYBRIDCLAW_AGENT_WORKSPACE_ROOT = ORIGINAL_WORKSPACE_ROOT;
  }
  if (ORIGINAL_WORKSPACE_DISPLAY_ROOT == null) {
    delete process.env.HYBRIDCLAW_AGENT_WORKSPACE_DISPLAY_ROOT;
  } else {
    process.env.HYBRIDCLAW_AGENT_WORKSPACE_DISPLAY_ROOT =
      ORIGINAL_WORKSPACE_DISPLAY_ROOT;
  }
  if (ORIGINAL_HEYGEN_ASSET_CACHE_DIR == null) {
    delete process.env.HEYGEN_ASSET_CACHE_DIR;
  } else {
    process.env.HEYGEN_ASSET_CACHE_DIR = ORIGINAL_HEYGEN_ASSET_CACHE_DIR;
  }
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

test('video.from-script skill manifest declares roadmap, dependency, and secret metadata', () => {
  const skill = fs.readFileSync(skillPath, 'utf-8');

  expect(skill).toContain('name: video.from-script');
  expect(skill).toContain('R55.2');
  expect(skill).toContain('issue: 875');
  expect(skill).toContain('R55.1');
  expect(skill).toContain('heygen');
  expect(skill).toContain('HEYGEN_API_KEY');
  expect(skill).toContain('UsageTotals');
});

test('video.from-script helper help and evals run without auth', () => {
  const help = runHelper(['--help']);
  const evals = runHelper(['--format', 'json', 'eval-scenarios']);

  expect(help.status).toBe(0);
  expect(help.stdout).toContain('video.from-script skill helper');
  expect(help.stdout).toContain('start');
  expect(help.stdout).toContain('status --job-id');
  expect(help.stdout).toContain('render');
  expect(help.stdout).not.toContain('--api-key ');
  expect(evals.status).toBe(0);
  expect(JSON.parse(evals.stdout)).toMatchObject({
    scenarioCount: 3,
    failed: 0,
  });
});

test('video.from-script builds guarded HeyGen start requests', () => {
  const payload = videoFromScript.buildStartRequest([
    '--avatar-id',
    'avatar_123',
    '--voice-id',
    'voice_123',
    '--script',
    'Approved script',
    '--title',
    'Launch update',
    '--resolution',
    '1080p',
    '--aspect-ratio',
    '16:9',
    '--operator-grant',
  ]);

  expect(payload.httpRequest).toMatchObject({
    method: 'POST',
    url: 'https://api.heygen.com/v2/videos',
    skillName: 'heygen',
    json: {
      avatar_id: 'avatar_123',
      voice_id: 'voice_123',
      script: 'Approved script',
      title: 'Launch update',
      resolution: '1080p',
      aspect_ratio: '16:9',
    },
    secretHeaders: [
      {
        name: 'X-API-KEY',
        secretName: 'HEYGEN_API_KEY',
        prefix: '',
      },
    ],
  });
});

test('video.from-script enforces avatar source exclusivity and accepts dash-prefixed scripts', () => {
  const duplicateAvatarSource = runHelper([
    '--format',
    'json',
    'start',
    '--avatar-id',
    'avatar_123',
    '--image-asset-id',
    'asset_123',
    '--voice-id',
    'voice_123',
    '--script',
    'Approved script',
    '--operator-grant',
  ]);

  const payload = videoFromScript.buildStartRequest([
    '--avatar-id',
    'avatar_123',
    '--voice-id',
    'voice_123',
    '--script',
    '-- Approved script opening',
    '--operator-grant',
  ]);

  expect(duplicateAvatarSource.status).not.toBe(0);
  expect(duplicateAvatarSource.stderr).toContain(
    'Provide exactly one of --avatar-id, --image-url, or --image-asset-id.',
  );
  expect(payload.httpRequest.json.script).toBe('-- Approved script opening');
});

test('video.from-script forwards HeyGen cache validation escape hatch', () => {
  const payload = videoFromScript.buildStartRequest([
    '--avatar-id',
    'private_avatar',
    '--voice-id',
    'private_voice',
    '--script',
    'Approved script',
    '--operator-grant',
    '--skip-cache-validation',
  ]);

  expect(payload.httpRequest.json).toMatchObject({
    avatar_id: 'private_avatar',
    voice_id: 'private_voice',
  });
});

test('video.from-script start returns async job id through gateway secret injection', async () => {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: new Headers(),
    text: async () =>
      JSON.stringify({
        ok: true,
        status: 200,
        headers: {},
        body: JSON.stringify({
          data: { video_id: 'video_123', status: 'pending' },
        }),
      }),
  });

  const result = await videoFromScript.startFromScript(
    [
      '--avatar-id',
      'avatar_123',
      '--voice-id',
      'voice_123',
      '--script',
      'Approved script',
      '--operator-grant',
    ],
    {
      gatewayUrl: 'http://127.0.0.1:9090',
      gatewayToken: 'gateway-token',
      fetch: fetchMock,
    },
  );

  expect(result).toMatchObject({
    success: true,
    jobId: 'video_123',
    ready: false,
  });
  expect(result).not.toHaveProperty('videoId');
  expect(fetchMock).toHaveBeenCalledWith(
    'http://127.0.0.1:9090/api/http/request',
    expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({
        Authorization: 'Bearer gateway-token',
      }),
    }),
  );
  const body = JSON.parse(fetchMock.mock.calls[0][1].body);
  expect(body.secretHeaders).toEqual([
    { name: 'X-API-KEY', secretName: 'HEYGEN_API_KEY', prefix: '' },
  ]);
});

test('video.from-script status downloads completed MP4 artifacts', async () => {
  const videoBytes = Buffer.from('fake-mp4');
  const fetchMock = vi.fn(async (url: string) => {
    if (url === 'https://cdn.heygen.example/video.mp4') {
      return new Response(videoBytes, {
        status: 200,
        headers: {
          'content-type': 'video/mp4',
          'content-length': String(videoBytes.length),
        },
      });
    }
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () =>
        JSON.stringify({
          ok: true,
          status: 200,
          headers: {},
          body: JSON.stringify({
            data: {
              video_id: 'video_123',
              status: 'completed',
              video_url: 'https://cdn.heygen.example/video.mp4',
              thumbnail_url: 'https://cdn.heygen.example/thumb.jpg',
            },
          }),
        }),
    };
  });

  const result = await videoFromScript.statusVideo(
    ['--job-id', 'video_123', '--download', '--filename', 'avatar-video.mp4'],
    {
      gatewayUrl: 'http://127.0.0.1:9090',
      fetch: fetchMock,
    },
  );

  expect(result).toMatchObject({
    success: true,
    jobId: 'video_123',
    state: 'completed',
    ready: true,
    videoUrl: 'https://cdn.heygen.example/video.mp4',
    artifact: {
      path: '/workspace/.generated-videos/avatar-video.mp4',
      filename: 'avatar-video.mp4',
      mimeType: 'video/mp4',
      bytes: videoBytes.length,
    },
    artifacts: [
      {
        path: '/workspace/.generated-videos/avatar-video.mp4',
        filename: 'avatar-video.mp4',
        mimeType: 'video/mp4',
        bytes: videoBytes.length,
      },
    ],
  });
  expect(
    fs.readFileSync(
      path.join(workspaceRoot, '.generated-videos', 'avatar-video.mp4'),
    ),
  ).toEqual(videoBytes);
});

test('video.from-script download rejects private completed video URLs', async () => {
  const fetchMock = vi.fn();

  await expect(
    videoFromScript.downloadVideo('http://127.0.0.1/video.mp4', {
      fetch: fetchMock,
    }),
  ).rejects.toThrow('private or internal video URL');
  await expect(
    videoFromScript.downloadVideo('http://[::ffff:127.0.0.1]/video.mp4', {
      fetch: fetchMock,
    }),
  ).rejects.toThrow('private or internal video URL');
  await expect(
    videoFromScript.downloadVideo('http://[::ffff:7f00:1]/video.mp4', {
      fetch: fetchMock,
    }),
  ).rejects.toThrow('private or internal video URL');
  expect(fetchMock).not.toHaveBeenCalled();
});

test('video.from-script download requires HTTPS and enforces size while streaming', async () => {
  const fetchMock = vi.fn(async () => {
    return new Response(Buffer.from('too-big'), {
      status: 200,
      headers: { 'content-type': 'video/mp4' },
    });
  });

  await expect(
    videoFromScript.downloadVideo('http://cdn.heygen.example/video.mp4', {
      fetch: fetchMock,
    }),
  ).rejects.toThrow('non-HTTPS video URL');
  expect(fetchMock).not.toHaveBeenCalled();

  await expect(
    videoFromScript.downloadVideo('https://cdn.heygen.example/video.mp4', {
      fetch: fetchMock,
      filename: 'oversized.mp4',
      maxDownloadBytes: 3,
    }),
  ).rejects.toThrow('exceeds max size');
  expect(
    fs.existsSync(
      path.join(workspaceRoot, '.generated-videos', 'oversized.mp4'),
    ),
  ).toBe(false);
});

test('video.from-script helper fails fast on unknown flags and zero poll interval', () => {
  const unknown = runHelper([
    '--format',
    'json',
    'start',
    '--avatar-id',
    'avatar_123',
    '--voice',
    'voice_123',
    '--script',
    'Approved script',
    '--operator-grant',
  ]);
  const zeroPoll = runHelper([
    '--format',
    'json',
    'render',
    '--wait',
    '--poll-interval-ms',
    '0',
  ]);

  expect(unknown.status).not.toBe(0);
  expect(unknown.stderr).toContain('Unexpected arguments: --voice voice_123');
  expect(zeroPoll.status).not.toBe(0);
  expect(zeroPoll.stderr).toContain('--poll-interval-ms must be at least 1000');
});

test('video.from-script render waits with bounded polling and downloads on completion', async () => {
  const videoBytes = Buffer.from('rendered-mp4');
  let statusCalls = 0;
  let now = 0;
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === 'https://cdn.heygen.example/rendered.mp4') {
      return new Response(videoBytes, {
        status: 200,
        headers: { 'content-type': 'video/mp4' },
      });
    }
    const body = JSON.parse(String(init?.body || '{}'));
    if (String(body.url).includes('/v2/videos')) {
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        text: async () =>
          JSON.stringify({
            ok: true,
            status: 200,
            headers: {},
            body: JSON.stringify({ data: { video_id: 'video_wait' } }),
          }),
      };
    }
    statusCalls += 1;
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () =>
        JSON.stringify({
          ok: true,
          status: 200,
          headers: {},
          body: JSON.stringify({
            data:
              statusCalls === 1
                ? { status: 'processing' }
                : {
                    status: 'completed',
                    video_url: 'https://cdn.heygen.example/rendered.mp4',
                  },
          }),
        }),
    };
  });

  const result = await videoFromScript.renderFromScript(
    [
      '--wait',
      '--avatar-id',
      'avatar_123',
      '--voice-id',
      'voice_123',
      '--script',
      'Approved script',
      '--operator-grant',
      '--poll-interval-ms',
      '1000',
      '--filename',
      'rendered.mp4',
    ],
    {
      gatewayUrl: 'http://127.0.0.1:9090',
      fetch: fetchMock,
      now: () => now,
      sleep: async (ms: number) => {
        now += ms;
      },
    },
  );

  expect(result).toMatchObject({
    success: true,
    state: 'completed',
    attempts: 2,
    artifact: {
      path: '/workspace/.generated-videos/rendered.mp4',
    },
    artifacts: [
      {
        path: '/workspace/.generated-videos/rendered.mp4',
      },
    ],
  });
  expect(statusCalls).toBe(2);
});
