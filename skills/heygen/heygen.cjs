#!/usr/bin/env node
'use strict';

const net = require('node:net');

const API_BASE = 'https://api.heygen.com';
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_API_KEY_SECRET = 'HEYGEN_API_KEY';

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

function popFlag(args, name, fallback = undefined) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) {
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

function parsePositiveInteger(raw, label) {
  if (!/^\d+$/.test(String(raw || ''))) {
    die(`${label} must be a positive integer.`);
  }
  const value = Number.parseInt(raw, 10);
  if (value <= 0) {
    die(`${label} must be a positive integer.`);
  }
  return value;
}

function parseRetryAfterMs(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (/^\d+(\.\d+)?$/.test(raw)) {
    return Math.max(0, Math.ceil(Number(raw) * 1_000));
  }
  const timestamp = Date.parse(raw);
  if (Number.isNaN(timestamp)) return null;
  return Math.max(0, timestamp - Date.now());
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
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (hostname === 'localhost' || hostname === '::1') return true;

  if (net.isIP(hostname) === 6) {
    if (
      hostname.startsWith('fe80:') ||
      hostname.startsWith('fc') ||
      hostname.startsWith('fd')
    ) {
      return true;
    }
    const mapped = ipv4OctetsFromMappedIpv6(hostname);
    return mapped ? isPrivateIpv4Octets(mapped) : false;
  }

  const octets = parseIpv4Octets(hostname);
  if (!octets) {
    return false;
  }
  return isPrivateIpv4Octets(octets);
}

function parseIpv4Octets(hostname) {
  const parts = hostname.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) {
    return null;
  }
  const octets = parts.map((part) => Number.parseInt(part, 10));
  if (octets.some((octet) => octet < 0 || octet > 255)) {
    return null;
  }
  return octets;
}

function ipv4OctetsFromMappedIpv6(hostname) {
  const dotted = hostname.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted) {
    return parseIpv4Octets(dotted[1]);
  }
  const packed = hostname.match(
    /^::ffff:(?:0:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/,
  );
  if (!packed) {
    return null;
  }
  const high = Number.parseInt(packed[1], 16);
  const low = Number.parseInt(packed[2], 16);
  return [high >> 8, high & 255, low >> 8, low & 255];
}

function isPrivateIpv4Octets(octets) {
  const [first, second] = octets;
  return (
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
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

function buildHttpRequest({ url, method = 'GET', json = undefined }) {
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
  requireGrant(args, 'video-generate');
  const avatarId = popFlag(args, '--avatar-id');
  const imageUrl = popFlag(args, '--image-url');
  const imageAssetId = popFlag(args, '--image-asset-id');
  const sources = [avatarId, imageUrl, imageAssetId].filter(Boolean);
  if (sources.length !== 1) {
    die(
      'Provide exactly one of --avatar-id, --image-url, or --image-asset-id.',
    );
  }
  const script = popFlag(args, '--script');
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

  const json = {};
  if (avatarId) json.avatar_id = required(avatarId, '--avatar-id');
  if (imageUrl) json.image_url = validatePublicUrl(imageUrl, '--image-url');
  if (imageAssetId)
    json.image_asset_id = required(imageAssetId, '--image-asset-id');
  if (script) json.script = required(script, '--script');
  if (voiceId) json.voice_id = required(voiceId, '--voice-id');
  if (audioUrl) json.audio_url = validatePublicUrl(audioUrl, '--audio-url');
  if (audioAssetId)
    json.audio_asset_id = required(audioAssetId, '--audio-asset-id');

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
  return buildHttpRequest({
    url: `${API_BASE}/v2/videos`,
    method: 'POST',
    json,
  });
}

function buildTranslateVideo(args) {
  requireGrant(args, 'video-translate');
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
  return buildHttpRequest({
    url: `${API_BASE}/v2/video_translate`,
    method: 'POST',
    json,
  });
}

function buildReadRequest(args) {
  const operation = args.shift();
  switch (operation) {
    case 'list-avatars':
      return buildHttpRequest({ url: `${API_BASE}/v2/avatars` });
    case 'list-voices':
      return buildHttpRequest({ url: `${API_BASE}/v2/voices` });
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
  const lower = body.toLowerCase();
  const rateLimited =
    status === 429 ||
    /rate.?limit|too many requests|quota exceeded|exceed rate limit|daily rate limit/i.test(
      body,
    );
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
      : lower.includes('insufficient credits')
        ? 'heygen-insufficient-credits'
        : retryable
          ? 'heygen-retryable-upstream'
          : 'not-retryable',
    rateLimitPolicy: RATE_LIMIT_POLICY,
  };
}

function runEvalScenarios() {
  const scenarios = [
    {
      name: 'read avatars',
      output: buildHttpRequest({ url: `${API_BASE}/v2/avatars` }),
      check: (output) =>
        output.httpRequest.method === 'GET' &&
        output.httpRequest.secretHeaders[0].secretName ===
          DEFAULT_API_KEY_SECRET,
    },
    {
      name: 'plan generation',
      output: classifyPlan('Create an avatar video from this approved script'),
      check: (output) =>
        output.operation === 'video-generate' && output.stakesTier === 'amber',
    },
    {
      name: 'rate limit',
      output: classifyRateLimit(['--status', '429', '--retry-after', '3']),
      check: (output) =>
        output.rateLimited === true && output.retryAfterMs === 3_000,
    },
  ];
  const failed = scenarios.filter(
    (scenario) => !scenario.check(scenario.output),
  );
  return {
    scenarioCount: scenarios.length,
    failed: failed.length,
    categories: {
      read: 1,
      planning: 1,
      'rate-limit': 1,
    },
  };
}

function helpText() {
  return `HeyGen skill helper

Usage:
  node skills/heygen/heygen.cjs plan <request>
  node skills/heygen/heygen.cjs http-request <operation> [flags]
  node skills/heygen/heygen.cjs request <operation> [flags]
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
  The request command sends the same secret-backed payload through the local gateway and retries bounded 429/5xx responses.`;
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
      payload = buildReadRequest(args);
      break;
    case 'request': {
      const { executeHeyGenGatewayRequest } = require('./client.cjs');
      payload = await executeHeyGenGatewayRequest(
        buildReadRequest(args).httpRequest,
      );
      break;
    }
    case 'classify-rate-limit':
      payload = classifyRateLimit(args);
      break;
    case 'eval-scenarios':
      payload = runEvalScenarios();
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
  buildReadRequest,
  buildHttpRequest,
  classifyPlan,
  classifyRateLimit,
  validatePublicUrl,
};
