/**
 * NCCO construction and Vonage voice webhook payload parsing.
 *
 * Every NCCO this module emits keeps the call in a strict turn loop: speak
 * (talk), then listen (speech input posting to our input webhook) — except
 * the goodbye NCCO, whose exhaustion is how a Vonage call is ended on
 * purpose. Talk text is chunked to Vonage's 1,500-char action limit.
 *
 * NOT the conversation engine — deciding *what* to say and when to transfer
 * a live call onto one of these NCCOs is vonage-manager/runtime territory.
 */
import { isRecord } from './utils.js';

const TALK_TEXT_LIMIT = 1_500;
// 30s/45s (owner call, 2026-08-06): reply turns give the caller 30s to start
// speaking; the park input stretches to 45s so slow agent turns keep the call
// alive between webhook round trips. Vonage caps a single utterance at 60s.
const REPLY_START_TIMEOUT_SECONDS = 30;
const PARK_START_TIMEOUT_SECONDS = 45;
const SPEECH_MAX_DURATION_SECONDS = 60;
const SPEECH_END_ON_SILENCE_SECONDS = 1.5;
function splitTalkText(text) {
  const normalized = String(text || '').trim();
  if (!normalized) return [];
  if (normalized.length <= TALK_TEXT_LIMIT) return [normalized];
  const chunks = [];
  let remaining = normalized;
  while (remaining.length > TALK_TEXT_LIMIT) {
    const window = remaining.slice(0, TALK_TEXT_LIMIT);
    const sentenceBreak = Math.max(
      window.lastIndexOf('. '),
      window.lastIndexOf('! '),
      window.lastIndexOf('? '),
    );
    const wordBreak = window.lastIndexOf(' ');
    const cut =
      sentenceBreak > TALK_TEXT_LIMIT / 2
        ? sentenceBreak + 1
        : wordBreak > 0
          ? wordBreak
          : TALK_TEXT_LIMIT;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
function buildTalkActions(params) {
  return splitTalkText(params.text).map((chunk) => ({
    action: 'talk',
    text: chunk,
    language: params.language,
    bargeIn: params.bargeIn,
  }));
}
function buildSpeechInputAction(settings, startTimeoutSeconds) {
  return {
    action: 'input',
    type: ['speech'],
    speech: {
      language: settings.language,
      startTimeout: startTimeoutSeconds,
      maxDuration: SPEECH_MAX_DURATION_SECONDS,
      endOnSilence: SPEECH_END_ON_SILENCE_SECONDS,
    },
    eventUrl: [settings.inputEventUrl],
    eventMethod: 'POST',
  };
}
export function buildReplyNcco(params) {
  return [
    ...buildTalkActions({
      text: params.text,
      language: params.language,
      bargeIn: params.interruptible,
    }),
    buildSpeechInputAction(params, REPLY_START_TIMEOUT_SECONDS),
  ];
}
export function buildParkNcco(settings) {
  return [buildSpeechInputAction(settings, PARK_START_TIMEOUT_SECONDS)];
}
export function buildGoodbyeNcco(params) {
  return buildTalkActions({
    text: params.message,
    language: params.language,
    bargeIn: false,
  });
}
function readString(record, key) {
  const value = record[key];
  return typeof value === 'string' ? value.trim() : '';
}
export function parseVonageAnswerWebhook(body) {
  if (!isRecord(body)) return null;
  const uuid = readString(body, 'uuid');
  if (!uuid) return null;
  return {
    uuid,
    conversationUuid: readString(body, 'conversation_uuid'),
    from: readString(body, 'from'),
    to: readString(body, 'to'),
    regionUrl: readString(body, 'region_url'),
  };
}
export function parseVonageInputWebhook(body) {
  if (!isRecord(body)) return null;
  const uuid = readString(body, 'uuid');
  if (!uuid) return null;
  let transcript = '';
  let timedOut = false;
  if (isRecord(body.speech)) {
    const timeoutReason = readString(body.speech, 'timeout_reason');
    timedOut = timeoutReason === 'start_timeout';
    const results = Array.isArray(body.speech.results)
      ? body.speech.results
      : [];
    const first = results.find(
      (entry) => isRecord(entry) && typeof entry.text === 'string',
    );
    transcript = first ? String(first.text).trim() : '';
  }
  let dtmfDigits = '';
  if (isRecord(body.dtmf)) {
    dtmfDigits = readString(body.dtmf, 'digits');
  }
  return {
    uuid,
    conversationUuid: readString(body, 'conversation_uuid'),
    transcript,
    timedOut,
    dtmfDigits,
  };
}
export function parseVonageEventWebhook(body) {
  if (!isRecord(body)) return null;
  const uuid = readString(body, 'uuid') || readString(body, 'call_uuid');
  if (!uuid) return null;
  return {
    uuid,
    conversationUuid: readString(body, 'conversation_uuid'),
    status: readString(body, 'status').toLowerCase(),
  };
}
export const VONAGE_TERMINAL_CALL_STATUSES = new Set([
  'completed',
  'failed',
  'rejected',
  'busy',
  'cancelled',
  'unanswered',
  'timeout',
]);
