import type WebSocket from 'ws';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function normalizeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
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

export interface ConversationRelaySetupMessage {
  type: 'setup';
  sessionId: string;
  accountSid: string;
  parentCallSid?: string;
  callSid: string;
  from: string;
  to: string;
  forwardedFrom?: string;
  callType?: string;
  callerName?: string;
  direction?: string;
  callStatus?: string;
  customParameters?: Record<string, string>;
}

export interface ConversationRelayPromptMessage {
  type: 'prompt';
  voicePrompt: string;
  lang?: string;
  last: boolean;
}

export interface ConversationRelayDtmfMessage {
  type: 'dtmf';
  digit: string;
}

export interface ConversationRelayInterruptMessage {
  type: 'interrupt';
  utteranceUntilInterrupt?: string;
  durationUntilInterruptMs?: number;
}

export interface ConversationRelayErrorMessage {
  type: 'error';
  description: string;
}

export type ConversationRelayInboundMessage =
  | ConversationRelaySetupMessage
  | ConversationRelayPromptMessage
  | ConversationRelayDtmfMessage
  | ConversationRelayInterruptMessage
  | ConversationRelayErrorMessage;

export function mergePromptFragment(
  existing: string,
  fragment: string,
): string {
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

export function parseConversationRelayMessage(
  raw: WebSocket.Data,
): ConversationRelayInboundMessage {
  const decoded = rawDataToString(raw).trim();
  if (!decoded) {
    throw new Error('ConversationRelay message was empty.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded) as unknown;
  } catch {
    throw new Error('ConversationRelay message was not valid JSON.');
  }
  if (!isRecord(parsed)) {
    throw new Error('ConversationRelay message must be a JSON object.');
  }
  const type = normalizeString(parsed.type);
  if (type === 'setup') {
    return {
      type,
      sessionId: normalizeString(parsed.sessionId),
      accountSid: normalizeString(parsed.accountSid),
      parentCallSid: normalizeString(parsed.parentCallSid) || undefined,
      callSid: normalizeString(parsed.callSid),
      from: normalizeString(parsed.from),
      to: normalizeString(parsed.to),
      forwardedFrom: normalizeString(parsed.forwardedFrom) || undefined,
      callType: normalizeString(parsed.callType) || undefined,
      callerName: normalizeString(parsed.callerName) || undefined,
      direction: normalizeString(parsed.direction) || undefined,
      callStatus: normalizeString(parsed.callStatus) || undefined,
      customParameters: isRecord(parsed.customParameters)
        ? Object.fromEntries(
            Object.entries(parsed.customParameters).map(([name, value]) => [
              name,
              normalizeString(value),
            ]),
          )
        : undefined,
    };
  }
  if (type === 'prompt') {
    return {
      type,
      voicePrompt: normalizeString(parsed.voicePrompt),
      lang: normalizeString(parsed.lang) || undefined,
      last: normalizeBoolean(parsed.last, true),
    };
  }
  if (type === 'dtmf') {
    return {
      type,
      digit: normalizeString(parsed.digit),
    };
  }
  if (type === 'interrupt') {
    return {
      type,
      utteranceUntilInterrupt:
        normalizeString(parsed.utteranceUntilInterrupt) || undefined,
      durationUntilInterruptMs: normalizeNumber(
        parsed.durationUntilInterruptMs,
      ),
    };
  }
  if (type === 'error') {
    return {
      type,
      description: normalizeString(parsed.description),
    };
  }
  throw new Error(
    `Unsupported ConversationRelay message type: ${type || 'unknown'}`,
  );
}

type SendFn = (payload: Record<string, unknown>) => Promise<void>;

export class ConversationRelayResponseStream {
  private closed = false;
  private pendingToken: string | null = null;
  private emittedText = false;

  constructor(
    private readonly send: SendFn,
    private readonly options: {
      interruptible: boolean;
      language: string;
      onFirstToken?: () => void;
      onFinished?: () => void;
    },
  ) {}

  get finished(): boolean {
    return this.closed;
  }

  get hasEmittedText(): boolean {
    return this.emittedText || Boolean(this.pendingToken);
  }

  async push(token: string, opts?: { language?: string }): Promise<void> {
    if (this.closed) return;
    const normalized = String(token || '');
    if (!normalized) return;
    if (this.pendingToken !== null) {
      await this.sendText(this.pendingToken, false, opts?.language);
    }
    this.pendingToken = normalized;
  }

  async reply(text: string, opts?: { language?: string }): Promise<void> {
    if (this.closed) return;
    await this.push(text, opts);
    await this.finish(opts);
  }

  async finish(opts?: { language?: string }): Promise<void> {
    if (this.closed) return;
    const finalToken = this.pendingToken;
    this.pendingToken = null;
    if (finalToken) {
      await this.sendText(finalToken, true, opts?.language);
    }
    this.closed = true;
    this.options.onFinished?.();
  }

  async endSession(handoffData?: string): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.send({
      type: 'end',
      ...(handoffData ? { handoffData } : {}),
    });
    this.options.onFinished?.();
  }

  private async sendText(
    token: string,
    last: boolean,
    language?: string,
  ): Promise<void> {
    if (!this.emittedText) {
      this.emittedText = true;
      this.options.onFirstToken?.();
    }
    await this.send({
      type: 'text',
      token,
      last,
      lang: language || this.options.language,
      interruptible: this.options.interruptible,
      preemptible: false,
    });
  }
}
