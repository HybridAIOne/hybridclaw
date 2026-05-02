const EXPECTED_TRANSPORT_ERROR_CODES = new Set([
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'EPIPE',
  'EAI_AGAIN',
  'ENETUNREACH',
  'ENOTFOUND',
  'ERR_SOCKET_CLOSED',
  'ESOCKETTIMEDOUT',
  'ETIMEOUT',
  'ETIMEDOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);

const EXPECTED_TRANSPORT_ERROR_MESSAGE_RE =
  /\b(opening handshake has timed out|client network socket disconnected|connect econnrefused|connect etimedout|connection reset|connection terminated|econnaborted|econnrefused|econnreset|ehostunreach|enetunreach|enotfound|eai_again|err_socket_closed|esockettimedout|etimeout|etimedout|fetch failed|network error|opening handshake|read econnreset|socket hang up|socket timeout|und_err_body_timeout|und_err_connect_timeout|und_err_headers_timeout|und_err_socket|websocket (?:connection |client )?(?:closed|error|timed out))\b/i;

interface ErrorLike {
  cause?: unknown;
  code?: unknown;
  hostname?: unknown;
  // Keep the standard AggregateError shape, but avoid speculative wrappers.
  errors?: unknown;
  message?: unknown;
}

const MAX_EXPECTED_TRANSPORT_ERROR_DEPTH = 3;

interface TransportErrorDetails {
  code: string;
  host: string;
  message: string;
}

function getOwnTransportErrorDetails(error: unknown): TransportErrorDetails {
  if (typeof error === 'string') {
    return {
      code: '',
      host: '',
      message: error,
    };
  }
  if (!error || typeof error !== 'object') {
    return {
      code: '',
      host: '',
      message: '',
    };
  }

  const candidate = error as ErrorLike;
  return {
    code:
      typeof candidate.code === 'string' ? candidate.code.toUpperCase() : '',
    host:
      typeof candidate.hostname === 'string' ? candidate.hostname.trim() : '',
    message: typeof candidate.message === 'string' ? candidate.message : '',
  };
}

function findTransportErrorDetails(
  error: unknown,
  depth = 0,
): TransportErrorDetails {
  if (depth > MAX_EXPECTED_TRANSPORT_ERROR_DEPTH || error == null) {
    return {
      code: '',
      host: '',
      message: '',
    };
  }

  const details = getOwnTransportErrorDetails(error);
  if (details.code || details.host) {
    return details;
  }

  if (error && typeof error === 'object') {
    const candidate = error as ErrorLike;
    if (Array.isArray(candidate.errors)) {
      for (const nested of candidate.errors) {
        const nestedDetails = findTransportErrorDetails(nested, depth + 1);
        if (nestedDetails.code || nestedDetails.host || nestedDetails.message) {
          return nestedDetails;
        }
      }
    }

    const causeDetails = findTransportErrorDetails(candidate.cause, depth + 1);
    if (causeDetails.code || causeDetails.host || causeDetails.message) {
      return causeDetails;
    }
  }

  return details;
}

function getTransportErrorCode(error: unknown): string {
  return findTransportErrorDetails(error).code;
}

function getTransportErrorHost(
  error: unknown,
  fallbackHost?: string | null,
): string {
  const host = findTransportErrorDetails(error).host;
  return host || String(fallbackHost || '').trim();
}

function hasMeaningfulHost(host: string): boolean {
  return host.length > 0;
}

function formatTransportEndpoint(subject: string, host: string): string {
  if (hasMeaningfulHost(host)) {
    return `${subject} connection to ${host}`;
  }
  return `${subject} connection`;
}

export function describeExpectedTransportError(
  error: unknown,
  subject: string,
  fallbackHost?: string | null,
): string {
  const code = getTransportErrorCode(error);
  const host = getTransportErrorHost(error, fallbackHost);

  switch (code) {
    case 'ENOTFOUND':
      return hasMeaningfulHost(host)
        ? `${subject} DNS lookup failed for ${host}.`
        : `${subject} DNS lookup failed.`;
    case 'EAI_AGAIN':
      return hasMeaningfulHost(host)
        ? `${subject} DNS lookup for ${host} is temporarily unavailable.`
        : `${subject} DNS lookup is temporarily unavailable.`;
    case 'ETIMEDOUT':
    case 'ETIMEOUT':
    case 'ESOCKETTIMEDOUT':
    case 'UND_ERR_CONNECT_TIMEOUT':
    case 'UND_ERR_HEADERS_TIMEOUT':
    case 'UND_ERR_BODY_TIMEOUT':
      return `${formatTransportEndpoint(subject, host)} timed out.`;
    case 'ECONNREFUSED':
      return `${formatTransportEndpoint(subject, host)} was refused.`;
    case 'ECONNRESET':
      return `${formatTransportEndpoint(subject, host)} was reset.`;
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return hasMeaningfulHost(host)
        ? `${subject} host ${host} is unreachable.`
        : `${subject} network is unreachable.`;
    case 'ERR_SOCKET_CLOSED':
    case 'UND_ERR_SOCKET':
    case 'EPIPE':
      return `${subject} socket closed unexpectedly.`;
    default:
      if (hasMeaningfulHost(host)) {
        return `${subject} is temporarily unavailable at ${host}.`;
      }
      return `${subject} is temporarily unavailable.`;
  }
}

function hasExpectedTransportSignature(
  code: string,
  message: string,
  messagePattern: RegExp,
): boolean {
  return (
    EXPECTED_TRANSPORT_ERROR_CODES.has(code) || messagePattern.test(message)
  );
}

function matchesExpectedTransportError(
  error: unknown,
  messagePattern: RegExp,
  depth = 0,
): boolean {
  if (depth > MAX_EXPECTED_TRANSPORT_ERROR_DEPTH || error == null) {
    return false;
  }
  if (typeof error === 'string') {
    return hasExpectedTransportSignature('', error, messagePattern);
  }
  if (typeof error !== 'object') {
    return false;
  }

  const candidate = error as ErrorLike;
  const code =
    typeof candidate.code === 'string' ? candidate.code.toUpperCase() : '';
  const message =
    typeof candidate.message === 'string' ? candidate.message : '';

  if (hasExpectedTransportSignature(code, message, messagePattern)) {
    return true;
  }

  if (
    Array.isArray(candidate.errors) &&
    candidate.errors.some((nested) =>
      matchesExpectedTransportError(nested, messagePattern, depth + 1),
    )
  ) {
    return true;
  }

  return matchesExpectedTransportError(
    candidate.cause,
    messagePattern,
    depth + 1,
  );
}

export function isExpectedTransportError(error: unknown): boolean {
  return matchesExpectedTransportError(
    error,
    EXPECTED_TRANSPORT_ERROR_MESSAGE_RE,
  );
}
