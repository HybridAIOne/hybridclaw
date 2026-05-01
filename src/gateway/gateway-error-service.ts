import { WhatsAppAuthLockError } from '../channels/whatsapp/auth.js';
import { formatError } from '../utils/text-format.js';
import {
  DEFAULT_CHANNEL_INTERRUPTED_REPLY,
  formatChannelGatewayFailure,
} from './channel-gateway-failure.js';

export function gatewayErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function formatGatewayErrorReply(error: unknown): string {
  return formatError('Gateway Error', gatewayErrorMessage(error));
}

export function formatAgentErrorReply(
  error: string | null | undefined,
): string {
  return formatError('Agent Error', error || 'Unknown error');
}

export function formatChannelGatewayErrorReply(error: unknown): string {
  return formatChannelGatewayFailure(
    error === null || error === undefined
      ? undefined
      : gatewayErrorMessage(error),
  );
}

export function isDefaultChannelInterruptedReply(text: string): boolean {
  return text === DEFAULT_CHANNEL_INTERRUPTED_REPLY;
}

export function isDiscordInvalidTokenError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code =
    'code' in error && typeof error.code === 'string' ? error.code : '';
  if (code === 'TokenInvalid') return true;
  const message =
    'message' in error && typeof error.message === 'string'
      ? error.message
      : '';
  return message.toLowerCase().includes('invalid token');
}

export function isWhatsAppAuthLockError(
  error: unknown,
): error is WhatsAppAuthLockError {
  return error instanceof WhatsAppAuthLockError;
}

export function isVoiceGatewayAbort(
  error: unknown,
  abortSignal: AbortSignal,
): boolean {
  return (
    abortSignal.aborted ||
    (error instanceof Error &&
      error.message === 'Voice websocket is not connected.')
  );
}
