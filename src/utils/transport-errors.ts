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
  'ETIMEDOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);

// Keep code strings here even when they also exist in the Set above. Some
// libraries only surface transport failures in `message`, not `code`, and they
// often embed the code inside longer text such as "connect ECONNREFUSED".
const EXPECTED_TRANSPORT_ERROR_MESSAGE_RE =
  /\b(opening handshake has timed out|client network socket disconnected|connect econnrefused|connect etimedout|connection reset|connection terminated|econnaborted|econnrefused|econnreset|ehostunreach|enetunreach|enotfound|eai_again|err_socket_closed|esockettimedout|etimedout|fetch failed|network error|opening handshake|read econnreset|socket hang up|und_err_body_timeout|und_err_connect_timeout|und_err_headers_timeout|und_err_socket|websocket (?:connection |client )?(?:closed|error|timed out))\b/i;

interface ErrorLike {
  cause?: unknown;
  code?: unknown;
  // Keep the standard AggregateError shape, but avoid speculative wrappers.
  errors?: unknown;
  message?: unknown;
}

const MAX_EXPECTED_TRANSPORT_ERROR_DEPTH = 3;

function hasExpectedTransportSignature(code: string, message: string): boolean {
  return (
    EXPECTED_TRANSPORT_ERROR_CODES.has(code) ||
    EXPECTED_TRANSPORT_ERROR_MESSAGE_RE.test(message)
  );
}

export function isExpectedTransportError(error: unknown, depth = 0): boolean {
  if (depth > MAX_EXPECTED_TRANSPORT_ERROR_DEPTH || error == null) {
    return false;
  }
  if (typeof error === 'string') {
    return hasExpectedTransportSignature('', error);
  }
  if (typeof error !== 'object') {
    return false;
  }

  const candidate = error as ErrorLike;
  const code =
    typeof candidate.code === 'string' ? candidate.code.toUpperCase() : '';
  const message =
    typeof candidate.message === 'string' ? candidate.message : '';

  if (hasExpectedTransportSignature(code, message)) {
    return true;
  }

  if (
    Array.isArray(candidate.errors) &&
    candidate.errors.some((nested) =>
      isExpectedTransportError(nested, depth + 1),
    )
  ) {
    return true;
  }

  return isExpectedTransportError(candidate.cause, depth + 1);
}
