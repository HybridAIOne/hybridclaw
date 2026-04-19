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

const EXPECTED_TRANSPORT_ERROR_MESSAGE_RE =
  /\b(opening handshake has timed out|client network socket disconnected|connect econnrefused|connect etimedout|connection reset|connection terminated|econnaborted|econnrefused|econnreset|ehostunreach|enetunreach|enotfound|eai_again|err_socket_closed|esockettimedout|etimedout|fetch failed|network error|opening handshake|read econnreset|socket hang up|und_err_body_timeout|und_err_connect_timeout|und_err_headers_timeout|und_err_socket|websocket (?:connection |client )?(?:closed|error|timed out))\b/i;

interface ErrorLike {
  cause?: unknown;
  code?: unknown;
  error?: unknown;
  errors?: unknown;
  message?: unknown;
}

function hasExpectedTransportSignature(code: string, message: string): boolean {
  return (
    EXPECTED_TRANSPORT_ERROR_CODES.has(code) ||
    EXPECTED_TRANSPORT_ERROR_MESSAGE_RE.test(message)
  );
}

export function isExpectedTransportError(error: unknown): boolean {
  const stack: unknown[] = [error];
  const visited = new Set<unknown>();

  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined || current === null || visited.has(current)) {
      continue;
    }
    visited.add(current);

    if (typeof current === 'string') {
      if (hasExpectedTransportSignature('', current)) {
        return true;
      }
      continue;
    }

    if (typeof current !== 'object') {
      continue;
    }

    const candidate = current as ErrorLike;
    const code =
      typeof candidate.code === 'string' ? candidate.code.toUpperCase() : '';
    const message =
      typeof candidate.message === 'string' ? candidate.message : '';

    if (hasExpectedTransportSignature(code, message)) {
      return true;
    }

    if (Array.isArray(candidate.errors)) {
      stack.push(...candidate.errors);
    }
    if (candidate.error !== undefined) {
      stack.push(candidate.error);
    }
    if (candidate.cause !== undefined) {
      stack.push(candidate.cause);
    }
  }

  return false;
}
