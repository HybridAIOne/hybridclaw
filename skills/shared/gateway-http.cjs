#!/usr/bin/env node
'use strict';

const DEFAULT_GATEWAY_URL = 'http://127.0.0.1:9090';
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_TIMEOUT_BUFFER_MS = 1_000;
const DEFAULT_GATEWAY_TOKEN_ENV_NAMES = [
  'HYBRIDCLAW_GATEWAY_TOKEN',
  'GATEWAY_API_TOKEN',
];
const DEFAULT_GATEWAY_URL_ENV_NAMES = [
  'HYBRIDCLAW_GATEWAY_URL',
  'GATEWAY_BASE_URL',
];

function parseJsonMaybe(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function resolveGatewayUrl(raw, options = {}) {
  const env = options.env || process.env;
  const envNames = options.gatewayUrlEnvNames || DEFAULT_GATEWAY_URL_ENV_NAMES;
  const defaultUrl = options.defaultUrl || DEFAULT_GATEWAY_URL;
  const value =
    String(raw || '').trim() ||
    envNames.map((name) => String(env[name] || '').trim()).find(Boolean) ||
    defaultUrl;
  const normalized = value.replace(/\/+$/u, '');

  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error('--gateway-url must be an absolute http or https URL.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('--gateway-url must use http or https.');
  }
  return normalized;
}

function resolveGatewayToken(raw, options = {}) {
  const env = options.env || process.env;
  const envNames =
    options.gatewayTokenEnvNames || DEFAULT_GATEWAY_TOKEN_ENV_NAMES;
  return (
    String(raw || '').trim() ||
    envNames.map((name) => String(env[name] || '').trim()).find(Boolean) ||
    ''
  );
}

function formatErrorCause(error) {
  if (!error || typeof error !== 'object') return '';
  const cause = error.cause;
  if (!cause) return '';
  if (cause instanceof Error) {
    const nested = formatErrorCause(cause);
    return nested && !cause.message.includes(nested)
      ? `${cause.message} (${nested})`
      : cause.message;
  }
  if (typeof cause === 'object') {
    const code = typeof cause.code === 'string' ? cause.code : '';
    const message = typeof cause.message === 'string' ? cause.message : '';
    return [code, message].filter(Boolean).join(' ');
  }
  return String(cause);
}

function formatTransportError(error) {
  if (!error) return 'unknown error';
  if (!(error instanceof Error)) return String(error);
  const cause = formatErrorCause(error);
  if (!cause || error.message.includes(cause)) return error.message;
  return `${error.message} (${cause})`;
}

function gatewayRequestUrl(gatewayUrl) {
  return `${gatewayUrl.replace(/\/+$/u, '')}/api/http/request`;
}

function extractResponseHeader(headers, name) {
  if (!headers) return '';
  if (typeof headers.get === 'function') return headers.get(name) || '';
  const normalizedName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === normalizedName) return String(value);
  }
  return '';
}

function gatewayErrorText(text) {
  const parsed = parseJsonMaybe(text);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return String(parsed.error || parsed.text || text || '').trim();
  }
  return String(text || '').trim();
}

function formatGatewayHttpError(response, text, options = {}) {
  const serviceName = options.serviceName || 'HTTP';
  const prefix = `Gateway proxy returned HTTP ${response.status} for ${serviceName} request`;
  const errorText = gatewayErrorText(text);

  if (
    response.status === 400 &&
    /not allowlisted by workspace network policy/u.test(errorText)
  ) {
    return `${prefix}: workspace network policy denied this helper-emitted target. ${errorText}`;
  }
  if (
    response.status === 502 &&
    /Outbound HTTP request failed/u.test(errorText)
  ) {
    return `${prefix}: gateway policy accepted the request, but the gateway process could not open the outbound connection. ${errorText}`;
  }
  return errorText ? `${prefix}: ${errorText}` : prefix;
}

async function sendGatewayRequest(httpRequest, options = {}) {
  const serviceName = options.serviceName || 'HTTP';
  const fetchImpl = options.fetch || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error(`fetch is not available for ${serviceName} requests.`);
  }

  const gatewayUrl = resolveGatewayUrl(options.gatewayUrl, options);
  const gatewayToken = resolveGatewayToken(options.gatewayToken, options);
  const headers = { 'Content-Type': 'application/json' };
  if (gatewayToken) headers.Authorization = `Bearer ${gatewayToken}`;

  const controller = new AbortController();
  const timeoutMs =
    httpRequest.timeoutMs || options.defaultTimeoutMs || DEFAULT_TIMEOUT_MS;
  const timeoutBufferMs =
    options.timeoutBufferMs ?? DEFAULT_TIMEOUT_BUFFER_MS;
  const timeout = setTimeout(
    () => controller.abort(),
    timeoutMs + timeoutBufferMs,
  );
  const url = gatewayRequestUrl(gatewayUrl);
  let response;
  let text = '';
  try {
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(httpRequest),
        signal: controller.signal,
      });
    } catch (error) {
      throw new Error(
        `Gateway proxy request failed before ${serviceName} request was sent: ${formatTransportError(
          error,
        )}. Check that the HybridClaw gateway is running and reachable at ${gatewayUrl}.`,
      );
    }
    text = await response.text();
  } finally {
    clearTimeout(timeout);
  }

  return { gatewayUrl, requestUrl: url, response, text };
}

function normalizeGatewayEnvelope(wrapper, fallbackStatus, options = {}) {
  const status = Number(wrapper.status || fallbackStatus || 0);
  const body = typeof wrapper.body === 'string' ? wrapper.body : '';
  const result = {
    ok: wrapper.ok !== false,
    status,
    statusText: wrapper.statusText || '',
    headers: wrapper.headers || {},
    body,
    bodyJson:
      wrapper.json && typeof wrapper.json === 'object'
        ? wrapper.json
        : parseJsonMaybe(body),
    bodyTruncated: wrapper.bodyTruncated === true,
    maxResponseBytes: wrapper.maxResponseBytes,
    bodySuppressed: wrapper.bodySuppressed === true,
    bodyBytes: wrapper.bodyBytes,
  };
  if (options.command) result.command = options.command;
  if (wrapper.success !== undefined) result.success = wrapper.success === true;
  if (wrapper.artifact !== undefined) result.artifact = wrapper.artifact;
  if (Array.isArray(wrapper.artifacts)) result.artifacts = wrapper.artifacts;
  if (wrapper.captured !== undefined) result.captured = wrapper.captured;
  if (wrapper.json !== undefined) result.json = wrapper.json;
  if (wrapper.url !== undefined) result.url = wrapper.url;
  return result;
}

function assertNotTruncated(result, options = {}) {
  if (!result.bodyTruncated) return;
  const serviceName = options.serviceName || 'HTTP';
  const guidance = options.guidance ? ` ${options.guidance}` : '';
  throw new Error(
    `${serviceName} response was truncated by the gateway at ${
      result.maxResponseBytes || 'the configured'
    } bytes.${guidance}`,
  );
}

async function executeGatewayRequest(httpRequest, options = {}) {
  const { response, text } = await sendGatewayRequest(httpRequest, options);
  const serviceName = options.serviceName || 'HTTP';
  if (!response.ok) {
    throw new Error(formatGatewayHttpError(response, text, { serviceName }));
  }

  const parsed = parseJsonMaybe(text);
  if (options.normalize === false) {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(
        `Gateway returned non-JSON response: ${text.slice(0, 500)}`,
      );
    }
    return parsed;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ...(options.command ? { command: options.command } : {}),
      ok: true,
      status: response.status,
      statusText: response.statusText || '',
      headers: {},
      body: text,
      bodyJson: null,
    };
  }

  const normalized = normalizeGatewayEnvelope(parsed, response.status, options);
  assertNotTruncated(normalized, {
    serviceName,
    guidance: options.truncationGuidance,
  });
  const allowedStatuses = options.allowedStatuses;
  const statusIsAllowed =
    Array.isArray(allowedStatuses) &&
    allowedStatuses.includes(normalized.status);
  if (
    options.rejectEnvelopeErrors !== false &&
    !normalized.ok &&
    (normalized.status < 300 || normalized.status > 399) &&
    !statusIsAllowed
  ) {
    throw new Error(
      `${serviceName} returned HTTP ${normalized.status || 'error'}: ${
        normalized.body || normalized.statusText
      }`,
    );
  }
  return normalized;
}

module.exports = {
  DEFAULT_GATEWAY_URL,
  assertNotTruncated,
  executeGatewayRequest,
  extractResponseHeader,
  formatGatewayHttpError,
  normalizeGatewayEnvelope,
  parseJsonMaybe,
  resolveGatewayToken,
  resolveGatewayUrl,
  sendGatewayRequest,
};
