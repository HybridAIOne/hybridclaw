import {
  isPremiumModelPermissionError,
  ProviderRequestError,
  type RuntimeProvider,
} from './providers/shared.js';

const DNS_CODE_SET = new Set(['EAI_AGAIN', 'ENODATA', 'ENOTFOUND']);
const TLS_CODE_SET = new Set([
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'EPROTO',
  'ERR_SSL_BAD_RECORD_TYPE',
  'ERR_SSL_WRONG_VERSION_NUMBER',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
]);
const TIMEOUT_CODE_SET = new Set([
  'ETIMEDOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
]);
const NETWORK_CODE_SET = new Set([
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'UND_ERR_SOCKET',
]);
const PROVIDER_OUTAGE_STATUS_SET = new Set([
  502, 503, 504, 521, 522, 523, 524, 529,
]);

const DNS_MESSAGE_RE =
  /\bdns\b|eai_again|enotfound|getaddrinfo|name resolution|no such host|server misbehaving/i;
const TLS_MESSAGE_RE =
  /\btls\b|\bssl\b|certificate|handshake|eproto|wrong version number|x509|unable to verify/i;
const TIMEOUT_MESSAGE_RE =
  /\btimeout\b|timed out|deadline exceeded|headers timeout|body timeout/i;
const NETWORK_MESSAGE_RE =
  /fetch failed|network error|socket|connection reset|reset by peer|connection refused|broken pipe|host is unreachable|network is unreachable|unexpected eof|terminated|econnreset|econnrefused|ehostunreach|enetunreach|eai_again/i;
const PROVIDER_OUTAGE_MESSAGE_RE =
  /overloaded|temporarily unavailable|service unavailable|upstream unavailable|please try again later|response\.failed|response\.incomplete|an error occurred while processing your request|server_error|gateway timeout/i;
const GENERIC_FETCH_MESSAGE_RE =
  /^(fetch failed|network error|request failed)$/i;

export type ModelErrorKind =
  | 'auth'
  | 'rate_limit'
  | 'dns'
  | 'tls'
  | 'timeout'
  | 'network'
  | 'http_5xx'
  | 'provider_outage'
  | 'bad_request'
  | 'unknown';

export interface ModelErrorClassification {
  kind: ModelErrorKind;
  retryable: boolean;
  autoRoute: boolean;
  status?: number;
  detail: string;
}

export interface ModelFailureTarget {
  provider: RuntimeProvider | undefined;
  model: string;
  baseUrl: string;
}

export interface ModelFailureRecord {
  target: ModelFailureTarget;
  classification: ModelErrorClassification;
  error: unknown;
}

function providerLabel(provider: RuntimeProvider | undefined): string {
  switch (provider) {
    case 'openai-codex':
      return 'OpenAI Codex';
    case 'openrouter':
      return 'OpenRouter';
    case 'mistral':
      return 'Mistral';
    case 'huggingface':
      return 'HuggingFace';
    case 'ollama':
      return 'Ollama';
    case 'lmstudio':
      return 'LM Studio';
    case 'llamacpp':
      return 'llama.cpp';
    case 'vllm':
      return 'vLLM';
    case 'hybridai':
    case undefined:
      return 'HybridAI';
    default:
      return String(provider);
  }
}

function targetPrefix(target: ModelFailureTarget): string {
  return `${providerLabel(target.provider)} model \`${target.model}\``;
}

function normalizeCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toUpperCase();
  return trimmed ? trimmed : null;
}

function collectErrorChain(error: unknown): Array<Record<string, unknown>> {
  const chain: Array<Record<string, unknown>> = [];
  const seen = new Set<unknown>();
  let current: unknown = error;

  while (
    current &&
    typeof current === 'object' &&
    !seen.has(current) &&
    chain.length < 8
  ) {
    seen.add(current);
    chain.push(current as Record<string, unknown>);
    current =
      current instanceof Error
        ? current.cause
        : (current as { cause?: unknown }).cause;
  }

  return chain;
}

function collectErrorCodes(error: unknown): string[] {
  const out: string[] = [];
  for (const item of collectErrorChain(error)) {
    const code = normalizeCode(item.code);
    if (code && !out.includes(code)) out.push(code);
  }
  return out;
}

function collectErrorMessages(error: unknown): string[] {
  const out: string[] = [];

  const add = (value: unknown): void => {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    if (!trimmed || out.includes(trimmed)) return;
    out.push(trimmed);
  };

  if (error instanceof Error) add(error.message);
  else add(String(error));

  for (const item of collectErrorChain(error)) {
    add(item.message);
  }

  return out;
}

function stripProviderErrorPrefix(message: string): string {
  return message.replace(/^Provider API error \d+:\s*/i, '').trim();
}

function selectPreferredDetail(error: unknown): string {
  if (error instanceof ProviderRequestError) {
    return (
      error.parsedBody?.message?.trim() ||
      stripProviderErrorPrefix(error.message) ||
      error.message
    );
  }

  const messages = collectErrorMessages(error);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!GENERIC_FETCH_MESSAGE_RE.test(message)) {
      return message;
    }
  }
  return messages[0] || String(error);
}

function hasMatchingCode(
  codes: readonly string[],
  candidates: ReadonlySet<string>,
): boolean {
  return codes.some((code) => candidates.has(code));
}

function withKind(
  kind: ModelErrorKind,
  detail: string,
  status?: number,
): ModelErrorClassification {
  const retryable =
    kind === 'rate_limit' ||
    kind === 'dns' ||
    kind === 'tls' ||
    kind === 'timeout' ||
    kind === 'network' ||
    kind === 'http_5xx' ||
    kind === 'provider_outage';
  const autoRoute =
    kind === 'dns' ||
    kind === 'tls' ||
    kind === 'timeout' ||
    kind === 'network' ||
    kind === 'http_5xx' ||
    kind === 'provider_outage';
  return {
    kind,
    retryable,
    autoRoute,
    ...(typeof status === 'number' ? { status } : {}),
    detail,
  };
}

export function classifyModelError(error: unknown): ModelErrorClassification {
  const detail = selectPreferredDetail(error);
  const lowerDetail = detail.toLowerCase();

  if (isPremiumModelPermissionError(error)) {
    return withKind('bad_request', detail, 403);
  }

  if (error instanceof ProviderRequestError) {
    const status = error.status;
    if (status === 401 || status === 403) {
      return withKind('auth', detail, status);
    }
    if (status === 429) {
      return withKind('rate_limit', detail, status);
    }
    if (status === 408) {
      return withKind('timeout', detail, status);
    }
    if (
      PROVIDER_OUTAGE_STATUS_SET.has(status) ||
      PROVIDER_OUTAGE_MESSAGE_RE.test(lowerDetail)
    ) {
      return withKind('provider_outage', detail, status);
    }
    if (status >= 500 && status <= 599) {
      return withKind('http_5xx', detail, status);
    }
    if (status >= 400 && status <= 499) {
      return withKind('bad_request', detail, status);
    }
  }

  const codes = collectErrorCodes(error);
  const messageBundle = collectErrorMessages(error).join('\n').toLowerCase();

  if (
    hasMatchingCode(codes, DNS_CODE_SET) ||
    DNS_MESSAGE_RE.test(messageBundle)
  ) {
    return withKind('dns', detail);
  }
  if (
    hasMatchingCode(codes, TLS_CODE_SET) ||
    TLS_MESSAGE_RE.test(messageBundle)
  ) {
    return withKind('tls', detail);
  }
  if (
    hasMatchingCode(codes, TIMEOUT_CODE_SET) ||
    TIMEOUT_MESSAGE_RE.test(messageBundle)
  ) {
    return withKind('timeout', detail);
  }
  if (PROVIDER_OUTAGE_MESSAGE_RE.test(messageBundle)) {
    return withKind('provider_outage', detail);
  }
  if (
    hasMatchingCode(codes, NETWORK_CODE_SET) ||
    NETWORK_MESSAGE_RE.test(messageBundle)
  ) {
    return withKind('network', detail);
  }

  return withKind('unknown', detail);
}

export function shouldAutoRouteFromModelError(error: unknown): boolean {
  return classifyModelError(error).autoRoute;
}

function extractHostLabel(baseUrl: string): string | null {
  try {
    return new URL(baseUrl).host || null;
  } catch {
    return null;
  }
}

function formatRateLimitOrAuthMessage(record: ModelFailureRecord): string {
  const prefix = `${targetPrefix(record.target)}: `;
  if (record.error instanceof ProviderRequestError) {
    return `${prefix}${record.error.message}`;
  }
  const detail =
    record.error instanceof Error ? record.error.message : String(record.error);
  return `${prefix}${detail}`;
}

export function formatModelFailureRecord(record: ModelFailureRecord): string {
  const label = targetPrefix(record.target);
  const endpoint = record.target.baseUrl.trim();
  const host = extractHostLabel(endpoint);
  const location = endpoint ? ` at \`${endpoint}\`` : '';
  const statusText =
    typeof record.classification.status === 'number'
      ? `HTTP ${record.classification.status} `
      : '';

  switch (record.classification.kind) {
    case 'dns':
      return `${label}: DNS lookup failed for \`${host || endpoint || 'the configured host'}\` (${record.classification.detail}).`;
    case 'tls':
      return `${label}: TLS negotiation failed${location} (${record.classification.detail}). Check certificates or the http/https scheme.`;
    case 'timeout':
      return `${label}: request timed out${location} (${record.classification.detail}).`;
    case 'network':
      return `${label}: network connection failed${location} (${record.classification.detail}).`;
    case 'provider_outage':
      return `${label}: provider outage detected${location ? `${location}` : ''} (${statusText}${record.classification.detail}).`;
    case 'http_5xx':
      return `${label}: returned ${statusText.trim() || 'an HTTP 5xx response'}${location} (${record.classification.detail}).`;
    case 'auth':
    case 'rate_limit':
    case 'bad_request':
    case 'unknown':
      return formatRateLimitOrAuthMessage(record);
    default:
      return `${label}: ${record.classification.detail}`;
  }
}

export function formatModelFailureSummary(
  failures: ModelFailureRecord[],
): string {
  if (failures.length <= 1) {
    return failures[0]
      ? formatModelFailureRecord(failures[0])
      : 'Model request failed.';
  }
  return `All configured model routes failed. ${failures
    .map((failure) => formatModelFailureRecord(failure))
    .join(' ')}`;
}

export class RoutedModelError extends Error {
  readonly failures: ModelFailureRecord[];

  constructor(failures: ModelFailureRecord[]) {
    super(formatModelFailureSummary(failures));
    this.name = 'RoutedModelError';
    this.failures = failures;
  }
}
