'use strict';

const DEFAULT_GATEWAY_URL = 'http://127.0.0.1:9090';
const DEFAULT_TIMEOUT_MS = 60_000;
const GATEWAY_TIMEOUT_BUFFER_MS = 5_000;
const RATE_LIMIT_BODY_RE =
  /rate.?limit|too many requests|quota exceeded|exceed rate limit|daily rate limit/i;

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

function resolveGatewayUrl() {
  return (
    (process.env.HYBRIDCLAW_GATEWAY_URL || '').trim() ||
    (process.env.GATEWAY_BASE_URL || '').trim() ||
    DEFAULT_GATEWAY_URL
  );
}

function resolveGatewayToken() {
  return (
    (process.env.HYBRIDCLAW_GATEWAY_TOKEN || '').trim() ||
    (process.env.GATEWAY_API_TOKEN || '').trim() ||
    (process.env.WEB_API_TOKEN || '').trim() ||
    ''
  );
}

function parseRetryAfterMs(value, nowMs = Date.now()) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (/^\d+(\.\d+)?$/.test(raw)) {
    return Math.max(0, Math.ceil(Number(raw) * 1_000));
  }
  const timestamp = Date.parse(raw);
  if (Number.isNaN(timestamp)) return null;
  return Math.max(0, timestamp - nowMs);
}

function parseJsonMaybe(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
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
  const rateLimited = status === 429 || RATE_LIMIT_BODY_RE.test(body);
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
    json,
    videoId:
      typeof record.video_id === 'string'
        ? record.video_id
        : typeof record.id === 'string'
          ? record.id
          : null,
    videoTranslateId:
      typeof record.video_translate_id === 'string'
        ? record.video_translate_id
        : typeof record.id === 'string'
          ? record.id
          : null,
    statusValue:
      typeof record.status === 'string'
        ? record.status
        : typeof record.state === 'string'
          ? record.state
          : null,
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
  const gatewayToken = options.gatewayToken || resolveGatewayToken();
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
    const headers = { 'Content-Type': 'application/json' };
    if (gatewayToken) headers.Authorization = `Bearer ${gatewayToken}`;
    const controller = new AbortController();
    const timeoutMs = httpRequest.timeoutMs || DEFAULT_TIMEOUT_MS;
    const timeout = setTimeout(
      () => controller.abort(),
      timeoutMs + GATEWAY_TIMEOUT_BUFFER_MS,
    );
    let response;
    try {
      response = await fetchImpl(`${gatewayUrl}/api/http/request`, {
        method: 'POST',
        headers,
        body: JSON.stringify(httpRequest),
        signal: controller.signal,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lastError = new HeyGenApiError(
        `Gateway proxy failed before HeyGen was contacted: ${message}`,
        { status: 0, retryable: true },
      );
    } finally {
      clearTimeout(timeout);
    }

    if (response) {
      const text = await response.text();
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
        const normalized = normalizeHeyGenPayload(wrapper);
        if (wrapper.ok === false) {
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

function createHeyGenClient(options = {}) {
  return {
    request: (httpRequest) => executeHeyGenGatewayRequest(httpRequest, options),
  };
}

module.exports = {
  HeyGenApiError,
  classifyHeyGenResponse,
  createHeyGenClient,
  executeHeyGenGatewayRequest,
  normalizeHeyGenPayload,
  parseRetryAfterMs,
};
