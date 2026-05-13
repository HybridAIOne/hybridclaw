#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const heygen = require('../heygen/heygen.cjs');
const {
  HeyGenApiError,
  executeHeyGenGatewayRequest,
} = require('../heygen/client.cjs');
const { isPrivateHostname } = require('../heygen/lib/common.cjs');

const DEFAULT_POLL_INTERVAL_MS = 10_000;
const MIN_POLL_INTERVAL_MS = 1_000;
const DEFAULT_MAX_WAIT_MS = 10 * 60_000;
const DEFAULT_MAX_DOWNLOAD_BYTES = 250 * 1024 * 1024;
const OUTPUT_DIR = '.generated-videos';
const TERMINAL_SUCCESS = new Set(['completed', 'complete', 'done', 'success']);
const TERMINAL_FAILURE = new Set(['failed', 'error', 'canceled', 'cancelled']);
const IN_PROGRESS = new Set(['pending', 'waiting', 'processing', 'queued']);

function die(message, code = 2) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function printJson(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function popFlag(args, name, fallback = undefined, options = {}) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (
    value === undefined ||
    (!options.allowDashValue && value.startsWith('--'))
  ) {
    die(`${name} requires a value.`);
  }
  args.splice(index, 2);
  return value;
}

function popBoolean(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return false;
  args.splice(index, 1);
  return true;
}

function required(value, label) {
  const normalized = String(value || '').trim();
  if (!normalized) die(`${label} is required.`);
  return normalized;
}

function parseNonNegativeInteger(raw, label, fallback) {
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(String(raw)))
    die(`${label} must be a non-negative integer.`);
  return Number.parseInt(raw, 10);
}

function parseIntegerWithMinimum(raw, label, fallback, minimum) {
  const value = parseNonNegativeInteger(raw, label, fallback);
  if (value < minimum) {
    die(`${label} must be at least ${minimum}.`);
  }
  return value;
}

function assertNoUnsupportedFlags(args) {
  const unsupported = args.find(
    (arg) => arg === '--api-key' || arg === '--api-key-secret',
  );
  if (unsupported) {
    die(
      `${unsupported} is not supported by video.from-script. Store HEYGEN_API_KEY in HybridClaw secrets and use gateway injection.`,
    );
  }
}

function buildStartRequest(args) {
  const operatorGrant = popBoolean(args, '--operator-grant');
  const forwarded = ['generate-video'];
  for (const flag of [
    '--avatar-id',
    '--image-url',
    '--image-asset-id',
    '--voice-id',
    '--script',
    '--title',
    '--resolution',
    '--aspect-ratio',
    '--motion-prompt',
    '--expressiveness',
    '--background-json',
    '--voice-settings-json',
  ]) {
    const value = popFlag(args, flag, undefined, {
      allowDashValue: flag === '--script',
    });
    if (value !== undefined) forwarded.push(flag, value);
  }
  for (const flag of ['--remove-background']) {
    if (popBoolean(args, flag)) forwarded.push(flag);
  }
  if (args.length > 0) die(`Unexpected arguments: ${args.join(' ')}`);
  if (operatorGrant) forwarded.push('--operator-grant');
  return heygen.buildRequest(forwarded);
}

function buildStatusRequest(args) {
  const jobId = required(popFlag(args, '--job-id'), '--job-id');
  return {
    jobId,
    request: heygen.buildRequest(['video-status', '--video-id', jobId]),
  };
}

function statusKind(status) {
  const normalized = String(status || '')
    .trim()
    .toLowerCase();
  if (!normalized) return 'unknown';
  if (TERMINAL_SUCCESS.has(normalized)) return 'completed';
  if (TERMINAL_FAILURE.has(normalized)) return 'failed';
  if (IN_PROGRESS.has(normalized)) return 'processing';
  return normalized;
}

function responseRecord(result) {
  const data = result.json?.data;
  return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
}

function responseErrorMessage(result) {
  const record = responseRecord(result);
  const error = record.error || record.error_message || record.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    if (typeof error.message === 'string') return error.message;
    return JSON.stringify(error);
  }
  return '';
}

function artifactPath(displayRoot, outputDir, filename) {
  return path.posix
    .join(displayRoot.replace(/\\/g, '/'), outputDir, filename)
    .replace(/\/+/g, '/');
}

function sanitizeFilenamePart(value) {
  return (
    String(value || 'video')
      .trim()
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'video'
  );
}

function extensionFromMimeType(mimeType, fallbackUrl) {
  const normalized = String(mimeType || '').toLowerCase();
  if (normalized.includes('webm')) return '.webm';
  if (normalized.includes('quicktime')) return '.mov';
  if (normalized.includes('mp4') || normalized.startsWith('video/'))
    return '.mp4';
  try {
    const ext = path.extname(new URL(fallbackUrl).pathname).toLowerCase();
    if (['.mp4', '.webm', '.mov'].includes(ext)) return ext;
  } catch {
    return '.mp4';
  }
  return '.mp4';
}

function resolveOutputPath(options) {
  const workspaceRoot =
    options.workspaceRoot ||
    process.env.HYBRIDCLAW_AGENT_WORKSPACE_ROOT ||
    process.cwd();
  const displayRoot =
    options.displayRoot ||
    process.env.HYBRIDCLAW_AGENT_WORKSPACE_DISPLAY_ROOT ||
    workspaceRoot;
  const outputDir = options.outputDir || OUTPUT_DIR;
  if (path.isAbsolute(outputDir) || outputDir.split(/[\\/]/).includes('..')) {
    throw new Error('--output-dir must be a workspace-relative path.');
  }
  const filename = options.filename;
  if (!filename || path.basename(filename) !== filename) {
    throw new Error('--filename must be a basename.');
  }
  const hostDir = path.resolve(workspaceRoot, outputDir);
  const hostPath = path.resolve(hostDir, filename);
  const rootWithSep = path.resolve(workspaceRoot) + path.sep;
  if (
    hostPath !== path.resolve(workspaceRoot) &&
    !hostPath.startsWith(rootWithSep)
  ) {
    throw new Error('Resolved output path escapes the workspace.');
  }
  return {
    hostDir,
    hostPath,
    displayPath: artifactPath(displayRoot, outputDir, filename),
  };
}

function assertPublicDownloadUrl(rawUrl) {
  const url = required(rawUrl, 'video URL');
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('HeyGen completed without a valid video URL.');
  }
  if (isPrivateHostname(parsed.hostname)) {
    throw new Error('HeyGen completed with a private or internal video URL.');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('HeyGen completed with a non-HTTPS video URL.');
  }
  return url;
}

async function writeResponseBodyToFile(response, hostPath, maxBytes) {
  if (!response.body || typeof response.body.getReader !== 'function') {
    throw new Error('Video download response did not include a readable body.');
  }
  const file = await fs.promises.open(hostPath, 'w');
  const reader = response.body.getReader();
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      bytes += chunk.length;
      if (bytes > maxBytes) {
        throw new Error(
          `Video download exceeds max size (${bytes} bytes > ${maxBytes}).`,
        );
      }
      await file.write(chunk);
    }
  } finally {
    await file.close();
    reader.releaseLock();
  }
  return bytes;
}

async function downloadVideo(videoUrl, options = {}) {
  const url = assertPublicDownloadUrl(videoUrl);
  const fetchImpl = options.fetch || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch is not available for video download.');
  }
  const maxBytes = options.maxDownloadBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs || 120_000,
  );
  let response;
  let artifact;
  let hostPath = '';
  try {
    response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Video download failed with HTTP ${response.status}.`);
    }
    const contentLength = Number.parseInt(
      response.headers.get('content-length') || '',
      10,
    );
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      throw new Error(
        `Video download exceeds max size (${contentLength} bytes > ${maxBytes}).`,
      );
    }
    const mimeType = response.headers.get('content-type') || 'video/mp4';
    const filename =
      options.filename ||
      `${sanitizeFilenamePart(options.jobId)}-${Date.now()}${extensionFromMimeType(
        mimeType,
        url,
      )}`;
    const resolved = resolveOutputPath({
      ...options,
      filename,
    });
    hostPath = resolved.hostPath;
    fs.mkdirSync(resolved.hostDir, { recursive: true });
    const bytes = await writeResponseBodyToFile(
      response,
      resolved.hostPath,
      maxBytes,
    );
    artifact = {
      path: resolved.displayPath,
      hostPath: resolved.hostPath,
      filename,
      mimeType,
      bytes,
    };
  } catch (error) {
    if (hostPath) {
      fs.rmSync(hostPath, { force: true });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  return artifact;
}

function normalizeStartResult(result) {
  if (!result.videoId) {
    throw new HeyGenApiError(
      'HeyGen start response did not include a video id.',
    );
  }
  return {
    success: true,
    jobId: result.videoId,
    status: result.statusValue || 'submitted',
    ready: false,
    next: {
      command: `node skills/video.from-script/video-from-script.cjs status --job-id ${result.videoId}`,
    },
  };
}

async function startFromScript(args, options = {}) {
  const request = buildStartRequest([...args]);
  const result = await executeHeyGenGatewayRequest(request.httpRequest, options);
  return {
    ...normalizeStartResult(result),
    rateLimit: request.rateLimit,
    costMeasurement: request.costMeasurement,
  };
}

async function statusVideo(args, options = {}) {
  const localArgs = [...args];
  const download = popBoolean(localArgs, '--download');
  const outputDir = popFlag(localArgs, '--output-dir', OUTPUT_DIR);
  const filename = popFlag(localArgs, '--filename');
  const maxDownloadBytes = parseNonNegativeInteger(
    popFlag(localArgs, '--max-download-bytes'),
    '--max-download-bytes',
    DEFAULT_MAX_DOWNLOAD_BYTES,
  );
  const { jobId, request } = buildStatusRequest(localArgs);
  if (localArgs.length > 0) die(`Unexpected arguments: ${localArgs.join(' ')}`);

  const result = await executeHeyGenGatewayRequest(request.httpRequest, options);
  const kind = statusKind(result.statusValue);
  const payload = {
    success: kind !== 'failed',
    jobId,
    status: result.statusValue || 'unknown',
    state: kind,
    ready: kind === 'completed',
    videoUrl: result.videoUrl,
    thumbnailUrl: result.thumbnailUrl,
    error: responseErrorMessage(result) || undefined,
  };
  if (kind === 'failed') {
    return payload;
  }
  if (download && kind === 'completed') {
    if (!result.videoUrl) {
      throw new Error('HeyGen completed without a downloadable video_url.');
    }
    const artifact = await downloadVideo(result.videoUrl, {
      ...options,
      jobId,
      outputDir,
      filename,
      maxDownloadBytes,
    });
    return {
      ...payload,
      artifact: {
        path: artifact.path,
        filename: artifact.filename,
        mimeType: artifact.mimeType,
        bytes: artifact.bytes,
      },
    };
  }
  return payload;
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function renderFromScript(args, options = {}) {
  const localArgs = [...args];
  const wait = popBoolean(localArgs, '--wait');
  const pollIntervalMs = parseIntegerWithMinimum(
    popFlag(localArgs, '--poll-interval-ms'),
    '--poll-interval-ms',
    DEFAULT_POLL_INTERVAL_MS,
    MIN_POLL_INTERVAL_MS,
  );
  const maxWaitMs = parseNonNegativeInteger(
    popFlag(localArgs, '--max-wait-ms'),
    '--max-wait-ms',
    DEFAULT_MAX_WAIT_MS,
  );
  const outputDir = popFlag(localArgs, '--output-dir', OUTPUT_DIR);
  const filename = popFlag(localArgs, '--filename');
  const maxDownloadBytes = parseNonNegativeInteger(
    popFlag(localArgs, '--max-download-bytes'),
    '--max-download-bytes',
    DEFAULT_MAX_DOWNLOAD_BYTES,
  );
  const started = await startFromScript(localArgs, options);
  if (!wait) {
    return started;
  }

  const sleepImpl = options.sleep || sleep;
  const startedAt = options.now ? options.now() : Date.now();
  let attempts = 0;
  while (true) {
    const statusArgs = [
      '--job-id',
      started.jobId,
      '--download',
      '--output-dir',
      outputDir,
      ...(filename ? ['--filename', filename] : []),
      '--max-download-bytes',
      String(maxDownloadBytes),
    ];
    const status = await statusVideo(statusArgs, options);
    attempts += 1;
    if (status.state === 'completed') {
      return {
        ...status,
        attempts,
      };
    }
    if (status.state === 'failed') {
      return {
        ...status,
        attempts,
      };
    }
    const now = options.now ? options.now() : Date.now();
    if (now - startedAt >= maxWaitMs) {
      return {
        ...status,
        attempts,
        success: false,
        timedOut: true,
        next: {
          command: `node skills/video.from-script/video-from-script.cjs status --job-id ${started.jobId} --download`,
        },
      };
    }
    await sleepImpl(pollIntervalMs);
  }
}

function classifyPlan(text) {
  const base = heygen.classifyPlan(text);
  return {
    ...base,
    skill: 'video.from-script',
    operation: 'video-from-script',
    async: true,
    requiredInputs: ['avatar-id or image source', 'voice-id', 'script'],
    output: 'mp4',
    recommendedWorkflow: ['start', 'status --job-id <id>', 'status --download'],
  };
}

function runEvalScenarios() {
  const checks = [];
  const start = buildStartRequest([
    '--avatar-id',
    'avatar_123',
    '--voice-id',
    'voice_123',
    '--script',
    'Approved script',
    '--operator-grant',
  ]);
  checks.push({
    name: 'start-request',
    passed:
      start.httpRequest.url === 'https://api.heygen.com/v2/videos' &&
      start.httpRequest.method === 'POST' &&
      start.httpRequest.secretHeaders?.some(
        (header) => header.secretName === 'HEYGEN_API_KEY',
      ),
  });
  const status = buildStatusRequest(['--job-id', 'video_123']);
  checks.push({
    name: 'status-request',
    passed:
      status.jobId === 'video_123' &&
      status.request.httpRequest.url.endsWith('video_id=video_123'),
  });
  const plan = classifyPlan('Create an approved avatar video from this script');
  checks.push({
    name: 'plan',
    passed:
      plan.operation === 'video-from-script' &&
      plan.requiredGrant === 'approve-heygen-video-generate' &&
      plan.async === true,
  });
  return {
    scenarioCount: checks.length,
    failed: checks.filter((check) => !check.passed).length,
    categories: {
      planning: 1,
      start: 1,
      status: 1,
    },
    checks,
  };
}

function helpText() {
  return `video.from-script skill helper

Usage:
  node skills/video.from-script/video-from-script.cjs plan <request>
  node skills/video.from-script/video-from-script.cjs start [flags]
  node skills/video.from-script/video-from-script.cjs status --job-id <id> [--download]
  node skills/video.from-script/video-from-script.cjs render [--wait] [flags]
  node skills/video.from-script/video-from-script.cjs eval-scenarios

Required start/render flags:
  exactly one avatar source:
    --avatar-id <id>
    --image-url <public-url>
    --image-asset-id <asset-id>
  --voice-id <id>
  --script <text>
  --operator-grant

Optional start/render flags:
  --title <title>
  --resolution 720p|1080p
  --aspect-ratio 16:9|9:16
  --motion-prompt <text>
  --expressiveness low|medium|high
  --remove-background
  --background-json <json>
  --voice-settings-json <json>

Polling/download flags:
  --wait
  --poll-interval-ms <ms>
  --max-wait-ms <ms>
  --download
  --output-dir <workspace-relative-dir>
  --filename <basename>
  --max-download-bytes <bytes>

Authentication:
  Store the Direct API key as HEYGEN_API_KEY. The helper sends HeyGen API requests through the HybridClaw gateway for secret injection.`;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.length === 0) {
    process.stdout.write(`${helpText()}\n`);
    return;
  }
  const format = popFlag(args, '--format', 'json');
  if (format !== 'json') die('--format only supports json.');
  assertNoUnsupportedFlags(args);
  const command = args.shift();
  let payload;
  switch (command) {
    case 'plan':
      payload = classifyPlan(args.join(' '));
      args.length = 0;
      break;
    case 'start':
      payload = await startFromScript(args);
      args.length = 0;
      break;
    case 'status':
      payload = await statusVideo(args);
      args.length = 0;
      break;
    case 'render':
      payload = await renderFromScript(args);
      args.length = 0;
      break;
    case 'eval-scenarios':
      payload = runEvalScenarios();
      args.length = 0;
      break;
    default:
      die(`Unknown command: ${command || '(missing)'}.`);
  }
  if (args.length > 0) {
    die(`Unexpected arguments: ${args.join(' ')}`);
  }
  printJson(payload);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  });
}

module.exports = {
  buildStartRequest,
  buildStatusRequest,
  classifyPlan,
  downloadVideo,
  renderFromScript,
  runEvalScenarios,
  startFromScript,
  statusKind,
  statusVideo,
};
