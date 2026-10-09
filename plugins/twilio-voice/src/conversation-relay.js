/**
 * Twilio ConversationRelay wire protocol: Twilio does speech recognition and
 * TTS, and this socket carries text turns only, never audio.
 *
 * Every inbound frame is validated JSON of a known type (`setup`, `prompt`,
 * `dtmf`, `interrupt`, `error`); anything else throws. The response stream
 * keeps one token in hand so the final `text` frame can carry `last: true`,
 * and serializes writes so tokens never interleave.
 */
import { isRecord, rawDataToString } from './utils.js';

function str(value) {
  return typeof value === 'string' ? value : '';
}

function optionalStr(value) {
  return str(value) || undefined;
}

function stringRecord(value) {
  return isRecord(value)
    ? Object.fromEntries(
        Object.entries(value).map(([name, entry]) => [name, str(entry)]),
      )
    : undefined;
}

const PARSERS = {
  setup: (parsed) => ({
    type: 'setup',
    sessionId: str(parsed.sessionId),
    accountSid: str(parsed.accountSid),
    callSid: str(parsed.callSid),
    from: str(parsed.from),
    to: str(parsed.to),
    callerName: optionalStr(parsed.callerName),
    direction: optionalStr(parsed.direction),
    customParameters: stringRecord(parsed.customParameters),
  }),
  prompt: (parsed) => ({
    type: 'prompt',
    voicePrompt: str(parsed.voicePrompt),
    lang: optionalStr(parsed.lang),
    last: typeof parsed.last === 'boolean' ? parsed.last : true,
  }),
  dtmf: (parsed) => ({ type: 'dtmf', digit: str(parsed.digit) }),
  interrupt: (parsed) => ({
    type: 'interrupt',
    utteranceUntilInterrupt: optionalStr(parsed.utteranceUntilInterrupt),
    durationUntilInterruptMs:
      typeof parsed.durationUntilInterruptMs === 'number' &&
      Number.isFinite(parsed.durationUntilInterruptMs)
        ? parsed.durationUntilInterruptMs
        : undefined,
  }),
  error: (parsed) => ({ type: 'error', description: str(parsed.description) }),
};

export function parseConversationRelayMessage(raw) {
  const decoded = rawDataToString(raw).trim();
  if (!decoded) throw new Error('ConversationRelay message was empty.');
  let parsed;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    throw new Error('ConversationRelay message was not valid JSON.');
  }
  if (!isRecord(parsed)) {
    throw new Error('ConversationRelay message must be a JSON object.');
  }
  const type = str(parsed.type);
  if (!Object.hasOwn(PARSERS, type)) {
    throw new Error(
      `Unsupported ConversationRelay message type: ${type || 'unknown'}`,
    );
  }
  return PARSERS[type](parsed);
}

/** Joins partial speech-recognition fragments into one prompt. */
export function mergePromptFragment(existing, fragment) {
  const left = String(existing || '');
  const right = String(fragment || '');
  if (!left) return right;
  if (!right) return left;
  if (right.startsWith(left)) return right;
  if (left.endsWith(right)) return left;
  const needsSpace =
    !/\s$/.test(left) && !/^\s/.test(right) && /^[A-Za-z0-9]/.test(right);
  return needsSpace ? `${left} ${right}` : `${left}${right}`;
}

export class ConversationRelayResponseStream {
  #closed = false;
  #pendingToken = null;
  #emittedText = false;
  #writeChain = Promise.resolve();

  constructor(send, options) {
    this.send = send;
    this.options = options;
  }

  get finished() {
    return this.#closed;
  }

  get hasEmittedText() {
    return this.#emittedText || Boolean(this.#pendingToken);
  }

  push(token, opts) {
    return this.#enqueue(async () => {
      if (this.#closed) return;
      const normalized = String(token || '');
      if (!normalized) return;
      if (this.#pendingToken !== null) {
        await this.#sendText(this.#pendingToken, false, opts?.language);
      }
      this.#pendingToken = normalized;
    });
  }

  reply(text, opts) {
    return this.#enqueue(async () => {
      if (this.#closed) return;
      const normalized = String(text || '');
      if (normalized && this.#pendingToken !== null) {
        await this.#sendText(this.#pendingToken, false, opts?.language);
      }
      this.#pendingToken = normalized || this.#pendingToken;
      await this.#finishNow(opts);
    });
  }

  finish(opts) {
    return this.#enqueue(() => this.#finishNow(opts));
  }

  async #sendText(token, last, language) {
    await this.send({
      type: 'text',
      token,
      last,
      lang: language || this.options.language,
      interruptible: this.options.interruptible,
      preemptible: false,
    });
    if (!this.#emittedText) {
      this.#emittedText = true;
      this.options.onFirstToken?.();
    }
  }

  async #finishNow(opts) {
    if (this.#closed) return;
    const finalToken = this.#pendingToken;
    this.#pendingToken = null;
    if (finalToken) await this.#sendText(finalToken, true, opts?.language);
    this.#closed = true;
    this.options.onFinished?.();
  }

  #enqueue(operation) {
    const next = this.#writeChain.then(operation);
    this.#writeChain = next.catch(() => {});
    return next;
  }
}
