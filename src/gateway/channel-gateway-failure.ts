import { formatError } from '../utils/text-format.js';
import { classifyGatewayError } from './gateway-error-utils.js';

const INTERRUPTED_GATEWAY_FAILURE_RE =
  /interrupted by user|timed out|timeout waiting for agent output|terminated|abort/i;

export function formatChannelGatewayFailure(
  error: string | null | undefined,
  interruptedReply: string,
  transientReply: string,
): string {
  const detail = String(error || '').trim();
  if (INTERRUPTED_GATEWAY_FAILURE_RE.test(detail)) {
    return interruptedReply;
  }
  if (detail && classifyGatewayError(detail) === 'transient') {
    return transientReply;
  }
  return formatError('Agent Error', detail || 'Unknown error');
}
