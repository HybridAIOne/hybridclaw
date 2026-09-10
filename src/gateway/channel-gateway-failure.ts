import { formatError } from '../utils/text-format.js';
import { classifyGatewayError } from './gateway-error-utils.js';

const GATEWAY_RESTARTING_RE = /gateway is restarting/i;
const INTERRUPTED_GATEWAY_FAILURE_RE =
  /interrupted by user|timed out|timeout waiting for agent output|terminated|abort/i;
export const DEFAULT_CHANNEL_INTERRUPTED_REPLY =
  'The request was interrupted before I could reply. Tools I had already started may have completed, so check before sending it again.';
export const DEFAULT_CHANNEL_TRANSIENT_FAILURE_REPLY =
  'The model request failed before I could reply. Please try again.';

export function formatChannelGatewayFailure(
  error: string | null | undefined,
  interruptedReply = DEFAULT_CHANNEL_INTERRUPTED_REPLY,
  transientReply = DEFAULT_CHANNEL_TRANSIENT_FAILURE_REPLY,
): string {
  const detail = String(error || '').trim();
  if (GATEWAY_RESTARTING_RE.test(detail)) {
    return detail;
  }
  if (INTERRUPTED_GATEWAY_FAILURE_RE.test(detail)) {
    return interruptedReply;
  }
  if (detail && classifyGatewayError(detail) === 'transient') {
    return transientReply;
  }
  return formatError('Agent Error', detail || 'Unknown error');
}
