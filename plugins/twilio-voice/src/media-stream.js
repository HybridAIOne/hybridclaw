/**
 * Twilio Media Streams wire protocol — the raw-audio counterpart to
 * `conversation-relay.js`.
 *
 * Every inbound frame is validated JSON of a known event (`connected`,
 * `start`, `media`, `dtmf`, `mark`, `stop`); anything else throws. Outbound
 * frames are `media` (base64 8 kHz µ-law) and `clear` (barge-in). Audio is
 * never decoded here; the core realtime session speaks µ-law natively.
 */
import { isRecord, rawDataToString } from './utils.js';

function str(value) {
  return typeof value === 'string' ? value : '';
}

const PARSERS = {
  connected: () => ({ type: 'connected' }),
  start: (parsed, streamSid) => {
    const start = isRecord(parsed.start) ? parsed.start : {};
    return {
      type: 'start',
      streamSid: streamSid || str(start.streamSid),
      callSid: str(start.callSid),
      customParameters: isRecord(start.customParameters)
        ? Object.fromEntries(
            Object.entries(start.customParameters).map(([name, value]) => [
              name,
              str(value),
            ]),
          )
        : undefined,
    };
  },
  media: (parsed, streamSid) => ({
    type: 'media',
    streamSid,
    payload: str(isRecord(parsed.media) ? parsed.media.payload : ''),
  }),
  dtmf: (parsed, streamSid) => ({
    type: 'dtmf',
    streamSid,
    digit: str(isRecord(parsed.dtmf) ? parsed.dtmf.digit : ''),
  }),
  mark: (_parsed, streamSid) => ({ type: 'mark', streamSid }),
  stop: (_parsed, streamSid) => ({ type: 'stop', streamSid }),
};

export function parseMediaStreamMessage(raw) {
  const decoded = rawDataToString(raw).trim();
  if (!decoded) throw new Error('Media stream message was empty.');
  let parsed;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    throw new Error('Media stream message was not valid JSON.');
  }
  if (!isRecord(parsed)) {
    throw new Error('Media stream message must be a JSON object.');
  }
  const event = str(parsed.event);
  if (!Object.hasOwn(PARSERS, event)) {
    throw new Error(`Unsupported media stream event: ${event || 'unknown'}`);
  }
  return PARSERS[event](parsed, str(parsed.streamSid));
}

export function buildMediaPayload(streamSid, base64Audio) {
  return { event: 'media', streamSid, media: { payload: base64Audio } };
}

/** Flushes audio Twilio has buffered but not yet played — the barge-in primitive. */
export function buildClearPayload(streamSid) {
  return { event: 'clear', streamSid };
}
