/**
 * Twilio Media Streams wire protocol — raw-audio counterpart to
 * `conversation-relay.ts` (which carries text turns, never audio).
 *
 * Guarantees every inbound frame is validated JSON of a known event type
 * (`connected`/`start`/`media`/`dtmf`/`mark`/`stop`) and every outbound frame
 * is a well-formed `media`/`clear`/`mark` message carrying base64 8kHz µ-law.
 * Audio payloads pass through opaque — this module never decodes, transcodes,
 * or buffers audio, and it never talks to a speech provider.
 */
import type WebSocket from 'ws';
import { isRecord } from '../../utils/type-guards.js';

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function rawDataToString(raw: WebSocket.Data): string {
  if (typeof raw === 'string') {
    return raw;
  }
  if (Buffer.isBuffer(raw)) {
    return raw.toString('utf8');
  }
  if (Array.isArray(raw)) {
    return Buffer.concat(raw).toString('utf8');
  }
  return Buffer.from(raw).toString('utf8');
}

export interface MediaStreamConnectedMessage {
  type: 'connected';
}

export interface MediaStreamStartMessage {
  type: 'start';
  streamSid: string;
  callSid: string;
  accountSid: string;
  customParameters?: Record<string, string>;
}

export interface MediaStreamMediaMessage {
  type: 'media';
  streamSid: string;
  /** Base64-encoded 8kHz mono µ-law audio. */
  payload: string;
}

export interface MediaStreamDtmfMessage {
  type: 'dtmf';
  streamSid: string;
  digit: string;
}

export interface MediaStreamMarkMessage {
  type: 'mark';
  streamSid: string;
  name: string;
}

export interface MediaStreamStopMessage {
  type: 'stop';
  streamSid: string;
  callSid: string;
}

export type MediaStreamInboundMessage =
  | MediaStreamConnectedMessage
  | MediaStreamStartMessage
  | MediaStreamMediaMessage
  | MediaStreamDtmfMessage
  | MediaStreamMarkMessage
  | MediaStreamStopMessage;

export function parseMediaStreamMessage(
  raw: WebSocket.Data,
): MediaStreamInboundMessage {
  const decoded = rawDataToString(raw).trim();
  if (!decoded) {
    throw new Error('Media stream message was empty.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded) as unknown;
  } catch {
    throw new Error('Media stream message was not valid JSON.');
  }
  if (!isRecord(parsed)) {
    throw new Error('Media stream message must be a JSON object.');
  }
  const event = normalizeString(parsed.event);
  const streamSid = normalizeString(parsed.streamSid);
  if (event === 'connected') {
    return { type: 'connected' };
  }
  if (event === 'start') {
    const start = isRecord(parsed.start) ? parsed.start : {};
    return {
      type: 'start',
      streamSid: streamSid || normalizeString(start.streamSid),
      callSid: normalizeString(start.callSid),
      accountSid: normalizeString(start.accountSid),
      customParameters: isRecord(start.customParameters)
        ? Object.fromEntries(
            Object.entries(start.customParameters).map(([name, value]) => [
              name,
              normalizeString(value),
            ]),
          )
        : undefined,
    };
  }
  if (event === 'media') {
    const media = isRecord(parsed.media) ? parsed.media : {};
    return {
      type: 'media',
      streamSid,
      payload: normalizeString(media.payload),
    };
  }
  if (event === 'dtmf') {
    const dtmf = isRecord(parsed.dtmf) ? parsed.dtmf : {};
    return {
      type: 'dtmf',
      streamSid,
      digit: normalizeString(dtmf.digit),
    };
  }
  if (event === 'mark') {
    const mark = isRecord(parsed.mark) ? parsed.mark : {};
    return {
      type: 'mark',
      streamSid,
      name: normalizeString(mark.name),
    };
  }
  if (event === 'stop') {
    const stop = isRecord(parsed.stop) ? parsed.stop : {};
    return {
      type: 'stop',
      streamSid,
      callSid: normalizeString(stop.callSid),
    };
  }
  throw new Error(`Unsupported media stream event: ${event || 'unknown'}`);
}

export function buildMediaStreamMediaPayload(
  streamSid: string,
  base64Audio: string,
): Record<string, unknown> {
  return {
    event: 'media',
    streamSid,
    media: { payload: base64Audio },
  };
}

/** Flushes Twilio's buffered outbound audio — the barge-in primitive. */
export function buildMediaStreamClearPayload(
  streamSid: string,
): Record<string, unknown> {
  return {
    event: 'clear',
    streamSid,
  };
}

export function buildMediaStreamMarkPayload(
  streamSid: string,
  name: string,
): Record<string, unknown> {
  return {
    event: 'mark',
    streamSid,
    mark: { name },
  };
}
