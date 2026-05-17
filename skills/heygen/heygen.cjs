#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  DEFAULT_TIMEOUT_MS,
  INSUFFICIENT_CREDITS_RE,
  isPrivateHostname,
  isRateLimitBody,
  parseRetryAfterMs,
} = require('./lib/common.cjs');
const { runEvalScenarios } = require('./eval.cjs');

const API_BASE = 'https://api.heygen.com';
const DEFAULT_API_KEY_SECRET = 'HEYGEN_API_KEY';
const ASSET_LIST_MAX_RESPONSE_BYTES = 5_000_000;
const DEFAULT_WATCH_INTERVAL_MS = 30_000;
const DEFAULT_WATCH_POLLS = 10;
const ASSET_CACHE_DIR_ENV = 'HEYGEN_ASSET_CACHE_DIR';

const COST_MEASUREMENT = {
  system: 'UsageTotals',
  source: 'HybridClaw usage_events',
  scope: 'per assistant run/session',
  fields: [
    'total_input_tokens',
    'total_output_tokens',
    'total_tokens',
    'total_cost_usd',
    'call_count',
    'total_tool_calls',
  ],
};

const RATE_LIMIT_POLICY = {
  provider: 'heygen',
  retryableStatuses: [429, 500, 502, 503, 504],
  maxAttempts: 3,
  minDelayMs: 2_000,
  maxDelayMs: 60_000,
  guidance:
    'Honor Retry-After on HTTP 429. Avoid parallel generate/translate bursts because HeyGen API quotas are per account and plan.',
};

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

function popRepeatedFlag(args, name) {
  const values = [];
  let index = args.indexOf(name);
  while (index !== -1) {
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) {
      die(`${name} requires a value.`);
    }
    values.push(value);
    args.splice(index, 2);
    index = args.indexOf(name);
  }
  return values;
}

function popBoolean(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return false;
  args.splice(index, 1);
  return true;
}

function parseJsonValue(raw, label) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    die(`${label} must be valid JSON: ${error.message}`);
  }
}

function parsePositiveInteger(raw, label, min = 1) {
  if (!/^\d+$/.test(String(raw || ''))) {
    die(
      min > 0
        ? `${label} must be a positive integer.`
        : `${label} must be a non-negative integer.`,
    );
  }
  const value = Number.parseInt(raw, 10);
  if (value < min) {
    die(
      min > 0
        ? `${label} must be a positive integer.`
        : `${label} must be a non-negative integer.`,
    );
  }
  return value;
}

function required(value, label) {
  const normalized = String(value || '').trim();
  if (!normalized) die(`${label} is required.`);
  return normalized;
}

function assertNoUnsupportedFlags(args) {
  const unsupported = args.find(
    (arg) => arg === '--api-key' || arg === '--api-key-secret',
  );
  if (unsupported) {
    die(
      `${unsupported} is not supported by the HeyGen helper. Store HEYGEN_API_KEY in HybridClaw secrets and use gateway injection.`,
    );
  }
}

function encodeQuery(params) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    query.set(key, String(value));
  }
  const queryString = query.toString();
  return queryString ? `?${queryString}` : '';
}

function isPrivateUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  return isPrivateHostname(parsed.hostname);
}

function validatePublicUrl(rawUrl, label) {
  const value = required(rawUrl, label);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    die(`${label} must be an absolute http(s) URL.`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    die(`${label} must be an absolute http(s) URL.`);
  }
  if (isPrivateUrl(value)) {
    die(`${label} must not target private or internal addresses.`);
  }
  return value;
}

function validateChoice(value, label, choices) {
  if (value === undefined || value === '') return undefined;
  if (!choices.includes(value)) {
    die(`${label} must be one of: ${choices.join(', ')}.`);
  }
  return value;
}

function resolveAssetCacheDir() {
  return path.resolve(
    process.env[ASSET_CACHE_DIR_ENV] ||
      path.join(process.cwd(), '.heygen-cache'),
  );
}

function cachePathForKind(kind) {
  return path.join(resolveAssetCacheDir(), `${kind}s.json`);
}

function readAssetCache(kind) {
  try {
    const raw = fs.readFileSync(cachePathForKind(kind), 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.items) ? parsed.items : [];
  } catch {
    return [];
  }
}

function writeAssetCache(kind, items) {
  const cacheDir = resolveAssetCacheDir();
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(
    cachePathForKind(kind),
    `${JSON.stringify(
      {
        kind,
        cachedAt: new Date().toISOString(),
        items,
      },
      null,
      2,
    )}\n`,
  );
}

function validateCachedAssetId(kind, id, label, skipCacheValidation) {
  if (!id || skipCacheValidation) return;
  if (/\s/.test(id)) {
    die(
      `${label} must be a HeyGen ${kind} id, not a display name. Run request list-${kind}s and use the exact id value.`,
    );
  }
  const items = readAssetCache(kind);
  if (items.length === 0) return;
  if (items.some((item) => item.id === id)) return;
  const nameMatch = items.find(
    (item) =>
      typeof item.name === 'string' &&
      item.name.toLowerCase() === id.toLowerCase(),
  );
  if (nameMatch?.id) {
    die(`${label} looks like a ${kind} display name. Use id ${nameMatch.id}.`);
  }
  die(
    `${label} was not found in the cached HeyGen ${kind} list. Run request list-${kind}s again or pass --skip-cache-validation if this is a known private asset id.`,
  );
}

function buildHttpRequest({
  url,
  method = 'GET',
  json = undefined,
  maxResponseBytes = undefined,
}) {
  const httpRequest = {
    url,
    method,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    secretHeaders: [
      {
        name: 'X-API-KEY',
        secretName: DEFAULT_API_KEY_SECRET,
        prefix: '',
      },
    ],
    skillName: 'heygen',
  };
  if (maxResponseBytes !== undefined) {
    httpRequest.maxResponseBytes = maxResponseBytes;
  }
  if (json !== undefined) {
    httpRequest.json = json;
  }
  return {
    command: 'http-request',
    httpRequest,
    rateLimit: RATE_LIMIT_POLICY,
    costMeasurement: COST_MEASUREMENT,
  };
}

function requireGrant(args, operation) {
  if (popBoolean(args, '--operator-grant')) return;
  die(
    `Refusing HeyGen ${operation} request without --operator-grant because it can consume API credits.`,
  );
}

function classifyPlan(text) {
  const normalized = text.toLowerCase();
  if (/\b(translate|locali[sz]e|dub|lip.?sync)\b/.test(normalized)) {
    return {
      operation: 'video-translate',
      stakesTier: 'amber',
      requiresEscalation: true,
      requiredGrant: 'approve-heygen-video-translate',
      rateLimitPolicy: RATE_LIMIT_POLICY,
      costMeasurement: COST_MEASUREMENT,
    };
  }
  if (
    /\b(generate|create|render|avatar|script|voice|video)\b/.test(normalized)
  ) {
    return {
      operation: 'video-generate',
      stakesTier: 'amber',
      requiresEscalation: true,
      requiredGrant: 'approve-heygen-video-generate',
      brandVoiceGateRequired: true,
      rateLimitPolicy: RATE_LIMIT_POLICY,
      costMeasurement: COST_MEASUREMENT,
    };
  }
  return {
    operation: 'asset-read',
    stakesTier: 'green',
    requiresEscalation: false,
    rateLimitPolicy: RATE_LIMIT_POLICY,
    costMeasurement: COST_MEASUREMENT,
  };
}

function buildGenerateVideo(args) {
  const skipCacheValidation = popBoolean(args, '--skip-cache-validation');
  const avatarId = popFlag(args, '--avatar-id');
  const imageUrl = popFlag(args, '--image-url');
  const imageAssetId = popFlag(args, '--image-asset-id');
  const sources = [avatarId, imageUrl, imageAssetId].filter(Boolean);
  if (sources.length !== 1) {
    die(
      'Provide exactly one of --avatar-id, --image-url, or --image-asset-id.',
    );
  }
  const script = popFlag(args, '--script', undefined, {
    allowDashValue: true,
  });
  const voiceId = popFlag(args, '--voice-id');
  const audioUrl = popFlag(args, '--audio-url');
  const audioAssetId = popFlag(args, '--audio-asset-id');
  if (script && !voiceId) die('--voice-id is required when --script is used.');
  if (script && (audioUrl || audioAssetId)) {
    die(
      '--script is mutually exclusive with --audio-url and --audio-asset-id.',
    );
  }
  if (!script && !audioUrl && !audioAssetId) {
    die('Provide --script with --voice-id, --audio-url, or --audio-asset-id.');
  }
  if (script && script.length > 5_000) {
    die('--script must be 5000 characters or fewer.');
  }
  validateCachedAssetId('avatar', avatarId, '--avatar-id', skipCacheValidation);
  validateCachedAssetId('voice', voiceId, '--voice-id', skipCacheValidation);

  const json = {};
  if (avatarId) json.avatar_id = avatarId;
  if (imageUrl) json.image_url = validatePublicUrl(imageUrl, '--image-url');
  if (imageAssetId) json.image_asset_id = imageAssetId;
  if (script) json.script = script;
  if (voiceId) json.voice_id = voiceId;
  if (audioUrl) json.audio_url = validatePublicUrl(audioUrl, '--audio-url');
  if (audioAssetId) json.audio_asset_id = audioAssetId;

  const title = popFlag(args, '--title');
  if (title) json.title = title;
  const resolution = validateChoice(
    popFlag(args, '--resolution'),
    '--resolution',
    ['720p', '1080p'],
  );
  if (resolution) json.resolution = resolution;
  const aspectRatio = validateChoice(
    popFlag(args, '--aspect-ratio'),
    '--aspect-ratio',
    ['16:9', '9:16'],
  );
  if (aspectRatio) json.aspect_ratio = aspectRatio;
  const motionPrompt = popFlag(args, '--motion-prompt');
  if (motionPrompt) json.motion_prompt = motionPrompt;
  const expressiveness = validateChoice(
    popFlag(args, '--expressiveness'),
    '--expressiveness',
    ['low', 'medium', 'high'],
  );
  if (expressiveness) json.expressiveness = expressiveness;
  if (popBoolean(args, '--remove-background')) json.remove_background = true;
  const backgroundJson = popFlag(args, '--background-json');
  if (backgroundJson)
    json.background = parseJsonValue(backgroundJson, '--background-json');
  const voiceSettingsJson = popFlag(args, '--voice-settings-json');
  if (voiceSettingsJson) {
    json.voice_settings = parseJsonValue(
      voiceSettingsJson,
      '--voice-settings-json',
    );
  }
  requireGrant(args, 'video-generate');
  return buildHttpRequest({
    url: `${API_BASE}/v2/videos`,
    method: 'POST',
    json,
  });
}

function buildTranslateVideo(args) {
  const videoUrl = validatePublicUrl(
    popFlag(args, '--video-url'),
    '--video-url',
  );
  const outputLanguage = popFlag(args, '--output-language');
  const outputLanguages = popRepeatedFlag(args, '--output-languages');
  if (outputLanguage && outputLanguages.length > 0) {
    die(
      'Use either --output-language or repeated --output-languages, not both.',
    );
  }
  if (!outputLanguage && outputLanguages.length === 0) {
    die('Provide --output-language or repeated --output-languages.');
  }
  const json = { video_url: videoUrl };
  if (outputLanguage) json.output_language = outputLanguage;
  if (outputLanguages.length > 0) json.output_languages = outputLanguages;
  const title = popFlag(args, '--title');
  if (title) json.title = title;
  if (popBoolean(args, '--translate-audio-only'))
    json.translate_audio_only = true;
  const speakerNum = popFlag(args, '--speaker-num');
  if (speakerNum)
    json.speaker_num = parsePositiveInteger(speakerNum, '--speaker-num');
  const callbackId = popFlag(args, '--callback-id');
  if (callbackId) json.callback_id = callbackId;
  const brandVoiceId = popFlag(args, '--brand-voice-id');
  if (brandVoiceId) json.brand_voice_id = brandVoiceId;
  const mode = validateChoice(popFlag(args, '--mode'), '--mode', [
    'fast',
    'quality',
  ]);
  if (mode) json.mode = mode;
  if (popBoolean(args, '--keep-the-same-format'))
    json.keep_the_same_format = true;
  requireGrant(args, 'video-translate');
  return buildHttpRequest({
    url: `${API_BASE}/v2/video_translate`,
    method: 'POST',
    json,
  });
}

function buildRequest(args) {
  const operation = args.shift();
  switch (operation) {
    case 'list-avatars':
      return buildHttpRequest({
        url: `${API_BASE}/v2/avatars`,
        maxResponseBytes: ASSET_LIST_MAX_RESPONSE_BYTES,
      });
    case 'list-voices':
      return buildHttpRequest({
        url: `${API_BASE}/v2/voices`,
        maxResponseBytes: ASSET_LIST_MAX_RESPONSE_BYTES,
      });
    case 'list-translation-languages':
      return buildHttpRequest({
        url: `${API_BASE}/v2/video_translate/target_languages`,
      });
    case 'video-status':
      return buildHttpRequest({
        url: `${API_BASE}/v1/video_status.get${encodeQuery({
          video_id: required(popFlag(args, '--video-id'), '--video-id'),
        })}`,
      });
    case 'translation-status':
      return buildHttpRequest({
        url: `${API_BASE}/v2/video_translate/${encodeURIComponent(
          required(
            popFlag(args, '--video-translate-id'),
            '--video-translate-id',
          ),
        )}`,
      });
    case 'generate-video':
      return buildGenerateVideo(args);
    case 'translate-video':
      return buildTranslateVideo(args);
    default:
      die(`Unknown http-request operation: ${operation || '(missing)'}.`);
  }
}

function classifyRateLimit(args) {
  const status = Number.parseInt(popFlag(args, '--status', '0'), 10) || 0;
  const retryAfterMs = parseRetryAfterMs(popFlag(args, '--retry-after', ''));
  const bodyText = popFlag(args, '--body', '');
  const bodyJson = popFlag(args, '--body-json');
  const body = bodyJson
    ? JSON.stringify(parseJsonValue(bodyJson, '--body-json'))
    : bodyText;
  const rateLimited = status === 429 || isRateLimitBody(body);
  const retryable =
    rateLimited || (status >= 500 && status <= 504 && status !== 501);
  return {
    provider: 'heygen',
    status,
    rateLimited,
    retryable,
    retryAfterMs:
      retryAfterMs ??
      (rateLimited ? RATE_LIMIT_POLICY.minDelayMs : retryable ? 5_000 : null),
    shouldBackoff: retryable,
    reason: rateLimited
      ? 'heygen-rate-limit'
      : INSUFFICIENT_CREDITS_RE.test(body)
        ? 'heygen-insufficient-credits'
        : retryable
          ? 'heygen-retryable-upstream'
          : 'not-retryable',
    rateLimitPolicy: RATE_LIMIT_POLICY,
  };
}

function isTerminalStatus(statusValue) {
  const normalized = String(statusValue || '').toLowerCase();
  return [
    'completed',
    'complete',
    'done',
    'success',
    'succeeded',
    'failed',
    'failure',
    'error',
    'cancelled',
    'canceled',
  ].includes(normalized);
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function executeRequestCommand(args) {
  const operation = args[0];
  const assetKind =
    operation === 'list-avatars'
      ? 'avatar'
      : operation === 'list-voices'
        ? 'voice'
        : null;
  const summary = assetKind
    ? !popBoolean(args, '--raw')
    : popBoolean(args, '--summary');
  const limit = summary
    ? parsePositiveInteger(popFlag(args, '--limit', '20'), '--limit')
    : 20;
  const watch = popBoolean(args, '--watch');
  const maxPolls = watch
    ? parsePositiveInteger(
        popFlag(args, '--max-polls', String(DEFAULT_WATCH_POLLS)),
        '--max-polls',
      )
    : DEFAULT_WATCH_POLLS;
  const intervalSeconds = watch
    ? parsePositiveInteger(
        popFlag(
          args,
          '--interval-seconds',
          String(DEFAULT_WATCH_INTERVAL_MS / 1000),
        ),
        '--interval-seconds',
        0,
      )
    : DEFAULT_WATCH_INTERVAL_MS / 1000;
  if (
    watch &&
    operation !== 'video-status' &&
    operation !== 'translation-status'
  ) {
    die('--watch is only supported for video-status and translation-status.');
  }
  if (summary && !assetKind) {
    die('--summary is only supported for list-avatars and list-voices.');
  }

  const requestArgs = [...args];
  const buildPreparedRequest = () => {
    const copy = [...requestArgs];
    const request = buildRequest(copy);
    if (copy.length > 0) {
      die(`Unexpected arguments: ${copy.join(' ')}`);
    }
    return request.httpRequest;
  };
  const preparedRequest = buildPreparedRequest();
  args.length = 0;

  const {
    executeHeyGenGatewayRequest,
    extractHeyGenAssetSummaries,
    summarizeHeyGenAssets,
  } = require('./client.cjs');
  const runOnce = () => executeHeyGenGatewayRequest(preparedRequest);

  if (watch) {
    const polls = [];
    for (let index = 0; index < maxPolls; index += 1) {
      const result = await runOnce();
      polls.push({
        poll: index + 1,
        status: result.statusValue || null,
        videoId: result.videoId,
        videoTranslateId: result.videoTranslateId,
        videoUrl: result.videoUrl,
        thumbnailUrl: result.thumbnailUrl,
      });
      if (isTerminalStatus(result.statusValue)) {
        return {
          watch: true,
          terminal: true,
          pollCount: polls.length,
          status: result.statusValue || null,
          result,
          polls,
        };
      }
      if (index + 1 < maxPolls) {
        await sleep(intervalSeconds * 1000);
      }
    }
    return {
      watch: true,
      terminal: false,
      pollCount: polls.length,
      status: polls.at(-1)?.status || null,
      hint: 'Polling budget exhausted. Re-run status later or increase --max-polls.',
      polls,
    };
  }

  const result = await runOnce();
  if (summary && assetKind) {
    const items = extractHeyGenAssetSummaries(result.json, { kind: assetKind });
    writeAssetCache(assetKind, items);
    return summarizeHeyGenAssets(result, { kind: assetKind, limit });
  }
  return result;
}

function helpText() {
  return `HeyGen skill helper

Usage:
  node skills/heygen/heygen.cjs plan <request>
  node skills/heygen/heygen.cjs http-request <operation> [flags]
  node skills/heygen/heygen.cjs request <operation> [--raw] [--limit <count>] [--watch]
  node skills/heygen/heygen.cjs classify-rate-limit --status <code> [--retry-after <seconds-or-date>] [--body-json <json>]
  node skills/heygen/heygen.cjs eval-scenarios

Read operations:
  list-avatars
  list-voices
  list-translation-languages
  video-status --video-id <id>
  translation-status --video-translate-id <id>

Credit-consuming operations, requiring --operator-grant:
  generate-video
    exactly one avatar source:
      --avatar-id <id>
      --image-url <public-url>
      --image-asset-id <asset-id>
    and exactly one audio source:
      --script <text> --voice-id <id>
      --audio-url <public-url>
      --audio-asset-id <asset-id>
    optional:
      --title <title>
      --resolution 720p|1080p
      --aspect-ratio 16:9|9:16
      --motion-prompt <text>
      --expressiveness low|medium|high
      --remove-background
      --background-json <json>
      --voice-settings-json <json>
      --skip-cache-validation
      --operator-grant

  translate-video
    required:
      --video-url <public-url>
      --output-language <language> OR repeated --output-languages <language>
    optional:
      --title <title>
      --mode fast|quality
      --translate-audio-only
      --speaker-num <count>
      --callback-id <id>
      --brand-voice-id <id>
      --keep-the-same-format
      --operator-grant

Authentication:
  Store the Direct API key as HEYGEN_API_KEY. The helper never accepts or prints API keys.
  The request command sends the same secret-backed payload through the local gateway and retries bounded 429/5xx responses.
  request list-avatars/list-voices summarize by default; pass --raw only when the full response is truly needed.
  Asset summaries are cached locally so generate-video can catch display names and stale ids before contacting HeyGen.
  request video-status/translation-status support bounded polling with --watch --max-polls <n> --interval-seconds <n>.
  eval-scenarios runs local adapter contract smoke checks without contacting HeyGen.`;
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
    case 'http-request':
      payload = buildRequest(args);
      break;
    case 'request': {
      payload = await executeRequestCommand(args);
      break;
    }
    case 'classify-rate-limit':
      payload = classifyRateLimit(args);
      break;
    case 'eval-scenarios':
      payload = runEvalScenarios({
        apiBase: API_BASE,
        apiKeySecret: DEFAULT_API_KEY_SECRET,
        buildHttpRequest,
        classifyPlan,
        classifyRateLimit,
      });
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
  RATE_LIMIT_POLICY,
  buildHttpRequest,
  buildRequest,
  classifyPlan,
  classifyRateLimit,
  executeRequestCommand,
  readAssetCache,
  validatePublicUrl,
  writeAssetCache,
};
