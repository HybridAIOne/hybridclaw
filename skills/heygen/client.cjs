'use strict';

const {
  normalizeGatewayEnvelope,
  parseJsonMaybe,
  resolveGatewayToken,
  resolveGatewayUrl,
  sendGatewayRequest,
} = require('../shared/gateway-http.cjs');
const {
  DEFAULT_TIMEOUT_MS,
  isRateLimitBody,
  parseRetryAfterMs,
} = require('./lib/common.cjs');

const GATEWAY_TOKEN_ENV_NAMES = [
  'HYBRIDCLAW_GATEWAY_TOKEN',
  'GATEWAY_API_TOKEN',
];

class HeyGenApiError extends Error {
  constructor(message, input = {}) {
    super(message);
    this.name = 'HeyGenApiError';
    this.code = input.code || 'HEYGEN_API_ERROR';
    this.status = input.status || null;
    this.retryable = Boolean(input.retryable);
    this.rateLimited = Boolean(input.rateLimited);
    this.retryAfterMs = input.retryAfterMs ?? null;
    this.body = input.body || '';
  }
}

function extractHeader(headers, name) {
  if (!headers) return '';
  if (typeof headers.get === 'function') return headers.get(name) || '';
  const lowerName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowerName) return String(value || '');
  }
  return '';
}

function classifyHeyGenResponse(input) {
  const status = Number(input.status || 0);
  const body = String(input.body || '');
  const retryAfterMs = parseRetryAfterMs(input.retryAfter);
  const rateLimited = status === 429 || isRateLimitBody(body);
  const retryable =
    rateLimited || (status >= 500 && status <= 504 && status !== 501);
  return {
    status,
    rateLimited,
    retryable,
    retryAfterMs:
      retryAfterMs ?? (rateLimited ? 2_000 : retryable ? 5_000 : null),
  };
}

function firstString(...candidates) {
  return candidates.find((candidate) => typeof candidate === 'string') ?? null;
}

function firstValue(record, keys) {
  return keys
    .map((key) => record[key])
    .find((value) => value !== undefined && value !== null && value !== '');
}

function compactString(value, maxLength = 160) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > maxLength
    ? `${trimmed.slice(0, maxLength - 3)}...`
    : trimmed;
}

function extractItemArray(json, kind) {
  const preferredKeys =
    kind === 'voice'
      ? ['voices', 'voice_list', 'voiceList']
      : ['avatars', 'avatar_list', 'avatarList'];
  const records = [
    json,
    json && typeof json === 'object' && !Array.isArray(json) ? json.data : null,
  ].filter(
    (value) => value && typeof value === 'object' && !Array.isArray(value),
  );

  for (const record of records) {
    for (const key of preferredKeys) {
      const candidate = record[key];
      if (Array.isArray(candidate)) return candidate;
    }
  }

  for (const record of records) {
    const candidate = Object.values(record).find(
      (value) =>
        Array.isArray(value) &&
        value.some((item) => item && typeof item === 'object'),
    );
    if (candidate) return candidate;
  }

  return [];
}

function summarizeItem(item, kind) {
  const id = firstValue(item, [
    `${kind}_id`,
    `${kind}Id`,
    'id',
    'asset_id',
    'assetId',
  ]);
  const previewUrl = firstValue(item, [
    'preview_url',
    'previewUrl',
    'sample_url',
    'sampleUrl',
    'audio_url',
    'audioUrl',
  ]);
  const thumbnailUrl = firstValue(item, [
    'thumbnail_url',
    'thumbnailUrl',
    'image_url',
    'imageUrl',
    'preview_image_url',
    'previewImageUrl',
  ]);
  const summary = {
    id: compactString(String(id || ''), 120),
    name: compactString(
      firstValue(item, [
        'name',
        `${kind}_name`,
        `${kind}Name`,
        'display_name',
        'displayName',
      ]),
    ),
    gender: compactString(firstValue(item, ['gender'])),
    language: compactString(
      firstValue(item, ['language', 'language_code', 'languageCode', 'locale']),
    ),
    accent: compactString(firstValue(item, ['accent'])),
    style: compactString(firstValue(item, ['style', 'type', 'category'])),
    previewUrl: compactString(previewUrl, 240),
    thumbnailUrl: compactString(thumbnailUrl, 240),
  };
  return Object.fromEntries(
    Object.entries(summary).filter(([, value]) => value !== undefined),
  );
}

function extractHeyGenAssetSummaries(json, { kind } = {}) {
  return extractItemArray(json, kind)
    .filter((item) => item && typeof item === 'object' && !Array.isArray(item))
    .map((item) => summarizeItem(item, kind));
}

function summarizeHeyGenAssets(normalized, { kind, limit = 20 } = {}) {
  const items = extractHeyGenAssetSummaries(normalized?.json, { kind });
  const safeLimit = Number(limit);
  if (!Number.isInteger(safeLimit) || safeLimit <= 0) {
    throw new Error('limit must be a positive integer.');
  }
  return {
    ok: normalized.ok,
    status: normalized.status,
    url: normalized.url,
    kind,
    count: items.length,
    returned: Math.min(items.length, safeLimit),
    bodyBytes: normalized.bodyBytes,
    maxResponseBytes: normalized.maxResponseBytes,
    bodyTruncated: normalized.bodyTruncated,
    items: items.slice(0, safeLimit),
  };
}

function normalizeHeyGenPayload(wrapper) {
  const body = typeof wrapper.body === 'string' ? wrapper.body : '';
  const json =
    wrapper.json !== undefined
      ? wrapper.json
      : body
        ? parseJsonMaybe(body)
        : undefined;
  const data =
    json && typeof json === 'object' && !Array.isArray(json)
      ? json.data
      : undefined;
  const record =
    data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  return {
    ok: wrapper.ok !== false,
    status: Number(wrapper.status || 0),
    statusText: String(wrapper.statusText || ''),
    url: String(wrapper.url || ''),
    headers:
      wrapper.headers && typeof wrapper.headers === 'object'
        ? wrapper.headers
        : {},
    body,
    bodyTruncated: Boolean(wrapper.bodyTruncated),
    bodyBytes:
      typeof wrapper.bodyBytes === 'number' ? wrapper.bodyBytes : undefined,
    maxResponseBytes:
      typeof wrapper.maxResponseBytes === 'number'
        ? wrapper.maxResponseBytes
        : undefined,
    json,
    videoId: firstString(record.video_id, record.id),
    videoTranslateId: firstString(record.video_translate_id, record.id),
    videoUrl: firstString(record.video_url, record.videoUrl, record.url),
    thumbnailUrl: firstString(record.thumbnail_url, record.thumbnailUrl),
    statusValue: firstString(record.status, record.state),
  };
}

function assertGatewayRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new HeyGenApiError('HeyGen gateway request must be an object.', {
      code: 'HEYGEN_CONFIG_ERROR',
    });
  }
  if (
    typeof input.url !== 'string' ||
    !input.url.startsWith('https://api.heygen.com/')
  ) {
    throw new HeyGenApiError(
      'HeyGen gateway request URL must target https://api.heygen.com/.',
      { code: 'HEYGEN_CONFIG_ERROR' },
    );
  }
  const secretHeaders = Array.isArray(input.secretHeaders)
    ? input.secretHeaders
    : [];
  const hasApiKeyHeader = secretHeaders.some(
    (header) =>
      header &&
      header.name === 'X-API-KEY' &&
      header.secretName === 'HEYGEN_API_KEY' &&
      header.prefix === '',
  );
  if (!hasApiKeyHeader) {
    throw new HeyGenApiError(
      'HeyGen gateway request must inject HEYGEN_API_KEY through X-API-KEY.',
      { code: 'HEYGEN_CONFIG_ERROR' },
    );
  }
}

function computeBackoffMs(error, attempt, maxDelayMs) {
  if (error.retryAfterMs !== null && error.retryAfterMs !== undefined) {
    return Math.min(error.retryAfterMs, maxDelayMs);
  }
  return Math.min(2_000 * 2 ** attempt, maxDelayMs);
}

async function defaultSleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function executeHeyGenGatewayRequest(httpRequest, options = {}) {
  assertGatewayRequest(httpRequest);
  const gatewayUrl = (options.gatewayUrl || resolveGatewayUrl()).replace(
    /\/+$/u,
    '',
  );
  const gatewayToken =
    options.gatewayToken ||
    resolveGatewayToken(undefined, {
      gatewayTokenEnvNames: GATEWAY_TOKEN_ENV_NAMES,
    });
  const fetchImpl = options.fetch || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new HeyGenApiError('fetch is not available for HeyGen requests.', {
      code: 'HEYGEN_CONFIG_ERROR',
    });
  }
  const sleep = options.sleep || defaultSleep;
  const maxAttempts = Math.max(1, options.maxAttempts || 3);
  const maxDelayMs = Math.max(0, options.maxDelayMs ?? 60_000);

  let lastError = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let response;
    let text = '';
    try {
      ({ response, text } = await sendGatewayRequest(httpRequest, {
        defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
        fetch: fetchImpl,
        gatewayToken,
        gatewayTokenEnvNames: GATEWAY_TOKEN_ENV_NAMES,
        gatewayUrl,
        serviceName: 'HeyGen',
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      response = undefined;
      lastError = new HeyGenApiError(
        `Gateway proxy failed before the HeyGen response completed: ${message}`,
        { status: 0, retryable: true },
      );
    }

    if (response) {
      if (!response.ok) {
        const retryAfter = extractHeader(response.headers, 'retry-after');
        const classification = classifyHeyGenResponse({
          status: response.status,
          body: text,
          retryAfter,
        });
        lastError = new HeyGenApiError(
          `Gateway proxy returned HTTP ${response.status} for HeyGen request: ${text}`,
          { ...classification, body: text },
        );
      } else {
        const wrapper = parseJsonMaybe(text);
        if (!wrapper || typeof wrapper !== 'object' || Array.isArray(wrapper)) {
          return normalizeHeyGenPayload({
            ok: true,
            status: response.status,
            body: text,
          });
        }
        const envelope = normalizeGatewayEnvelope(wrapper, response.status);
        if (envelope.bodyTruncated) {
          throw new HeyGenApiError(
            `HeyGen response was truncated by the gateway at ${envelope.maxResponseBytes || 'the configured'} bytes. Use a larger maxResponseBytes value or a summary-mode helper command.`,
            {
              code: 'HEYGEN_RESPONSE_TRUNCATED',
              status: Number(envelope.status || response.status || 0),
              retryable: false,
              body: typeof envelope.body === 'string' ? envelope.body : text,
            },
          );
        }
        const normalized = normalizeHeyGenPayload(envelope);
        if (envelope.ok === false) {
          const retryAfter = extractHeader(normalized.headers, 'retry-after');
          const classification = classifyHeyGenResponse({
            status: normalized.status,
            body: normalized.body || text,
            retryAfter,
          });
          lastError = new HeyGenApiError(
            `HeyGen returned HTTP ${normalized.status || 'error'}: ${
              normalized.body || normalized.statusText
            }`,
            { ...classification, body: normalized.body || text },
          );
        } else {
          return normalized;
        }
      }
    }

    if (!lastError?.retryable || attempt === maxAttempts - 1) {
      throw lastError;
    }
    await sleep(computeBackoffMs(lastError, attempt, maxDelayMs));
  }
  throw lastError;
}

module.exports = {
  HeyGenApiError,
  classifyHeyGenResponse,
  executeHeyGenGatewayRequest,
  extractHeyGenAssetSummaries,
  normalizeHeyGenPayload,
  parseRetryAfterMs,
  summarizeHeyGenAssets,
};
