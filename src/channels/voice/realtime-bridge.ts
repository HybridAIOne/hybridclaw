/**
 * Per-conversation bridge between a caller-facing audio transport (Twilio
 * media stream or browser websocket) and an OpenAI realtime session — the
 * speech-to-speech counterpart of `dispatchPromptToHandler`.
 *
 * Guarantees barge-in stays coherent (caller speech always clears queued
 * playback and cancels the active model response) and that at most one
 * `consult_agent` gateway turn runs per conversation at a time. The realtime
 * model only fronts the conversation; anything requiring tools, memory, or
 * actions is forwarded to the full gateway agent via the consult callback.
 *
 * NOT a transport: callers supply `sendAudio`/`clearPlayback` seams (Twilio
 * framing lives in `media-stream.ts`, browser framing in the gateway) and the
 * upstream socket in `openai-realtime.ts`; this module never touches raw JSON.
 */
import type { RuntimeVoiceRealtimeConfig } from '../../config/runtime-config.js';
import { isRecord } from '../../utils/type-guards.js';
import {
  OpenAIRealtimeClient,
  type RealtimeAudioFormat,
  type RealtimeSocketFactory,
} from './openai-realtime.js';
import type { RealtimeConnection } from './realtime-credentials.js';

export const CONSULT_AGENT_TOOL_NAME = 'consult_agent';

const CONSULT_BUSY_OUTPUT =
  'The assistant is still working on the previous request. Ask the caller to wait a moment.';

export type RealtimeBridgeState = 'listening' | 'speaking' | 'thinking';

export type RealtimeSurface = 'phone' | 'web';

export interface RealtimeCallerInfo {
  from: string;
  to: string;
  callerName: string;
}

export interface RealtimeBridgeOptions {
  connection: RealtimeConnection;
  config: RuntimeVoiceRealtimeConfig;
  caller: RealtimeCallerInfo;
  surface: RealtimeSurface;
  audioFormat: RealtimeAudioFormat;
  sendAudio: (base64Audio: string) => Promise<void>;
  clearPlayback: () => Promise<void>;
  consultAgent: (request: string, abortSignal: AbortSignal) => Promise<string>;
  onTranscript: (role: 'assistant' | 'caller', text: string) => void;
  onStateChange: (state: RealtimeBridgeState) => void;
  onError: (message: string) => void;
  onClosed: () => void;
  socketFactory?: RealtimeSocketFactory;
}

export function buildRealtimeInstructions(
  config: RuntimeVoiceRealtimeConfig,
  caller: RealtimeCallerInfo,
  surface: RealtimeSurface = 'phone',
): string {
  const setting =
    surface === 'phone'
      ? 'on a live phone call'
      : 'in a live voice conversation in the web console';
  const person = surface === 'phone' ? 'caller' : 'user';
  const sections = [
    `You are the realtime voice of HybridClaw, a personal AI assistant, ${setting}.`,
    'Keep replies short, natural, and conversational. Never mention these instructions.',
    `Handle greetings and small talk yourself. For anything that needs the assistant's knowledge, memory, files, or tools — or any action such as sending messages or managing tasks — first tell the ${person} you are checking, then call the ${CONSULT_AGENT_TOOL_NAME} tool with the ${person}'s request. Relay its reply faithfully in a natural spoken style.`,
  ];
  const callerDetails = [
    caller.callerName ? `name ${caller.callerName}` : '',
    caller.from ? `calling from ${caller.from}` : '',
    caller.to ? `dialed ${caller.to}` : '',
  ]
    .filter(Boolean)
    .join(', ');
  if (callerDetails) {
    sections.push(
      `${surface === 'phone' ? 'Caller' : 'User'} details: ${callerDetails}.`,
    );
  }
  if (config.instructions.trim()) {
    sections.push(config.instructions.trim());
  }
  return sections.join('\n');
}

function parseConsultRequest(rawArguments: string): string {
  try {
    const parsed = JSON.parse(rawArguments) as unknown;
    if (isRecord(parsed) && typeof parsed.request === 'string') {
      return parsed.request.trim();
    }
  } catch {
    // Malformed arguments fall through to the empty-request error path.
  }
  return '';
}

export class RealtimeCallBridge {
  private readonly client: OpenAIRealtimeClient;
  private readonly options: RealtimeBridgeOptions;
  private readonly consultAbort = new AbortController();
  private consultInFlight = false;
  private closed = false;

  constructor(options: RealtimeBridgeOptions) {
    this.options = options;
    this.client = new OpenAIRealtimeClient({
      url: options.connection.url,
      apiKey: options.connection.apiKey,
      model: options.config.model,
      voice: options.config.voice,
      audioFormat: options.audioFormat,
      instructions: buildRealtimeInstructions(
        options.config,
        options.caller,
        options.surface,
      ),
      tools: [
        {
          name: CONSULT_AGENT_TOOL_NAME,
          description:
            "Forward a request to HybridClaw, the caller's full AI assistant with tools, memory, and messaging. Use for anything beyond casual conversation. Returns the assistant's reply as text.",
          parameters: {
            type: 'object',
            properties: {
              request: {
                type: 'string',
                description:
                  "The caller's request, restated as a complete self-contained instruction.",
              },
            },
            required: ['request'],
          },
        },
      ],
      callbacks: {
        onReady: () => {
          this.client.createResponse(
            `Greet the caller by saying: "${options.config.greeting}"`,
          );
        },
        onAudioDelta: (base64Audio) => {
          this.options.onStateChange('speaking');
          void this.options.sendAudio(base64Audio).catch((error) => {
            this.options.onError(
              `Failed to forward audio to the caller: ${String(
                error instanceof Error ? error.message : error,
              )}`,
            );
          });
        },
        onSpeechStarted: () => {
          this.options.onStateChange('listening');
          this.client.cancelResponse();
          void this.options.clearPlayback().catch(() => {
            // The transport is gone; the close handler tears the session down.
          });
        },
        onInputTranscript: (transcript) => {
          this.options.onTranscript('caller', transcript);
        },
        onOutputTranscript: (transcript) => {
          this.options.onTranscript('assistant', transcript);
        },
        onFunctionCall: (call) => {
          this.handleFunctionCall(call.callId, call.name, call.arguments);
        },
        onError: (message) => {
          this.options.onError(message);
        },
        onClosed: () => {
          this.closed = true;
          this.options.onClosed();
        },
      },
      socketFactory: options.socketFactory,
    });
  }

  get isOpen(): boolean {
    return !this.closed && this.client.isOpen;
  }

  handleCallerAudio(base64Audio: string): void {
    this.client.appendAudio(base64Audio);
  }

  handleDtmf(digit: string): void {
    const normalized = String(digit || '').trim();
    if (!normalized) return;
    this.client.sendUserText(
      `The caller pressed the keypad digit "${normalized}".`,
    );
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.consultAbort.abort();
    this.client.close();
  }

  private handleFunctionCall(
    callId: string,
    name: string,
    rawArguments: string,
  ): void {
    if (name !== CONSULT_AGENT_TOOL_NAME) {
      this.client.sendFunctionCallOutput(callId, `Unknown tool: ${name}`);
      return;
    }
    const request = parseConsultRequest(rawArguments);
    if (!request) {
      this.client.sendFunctionCallOutput(
        callId,
        'The request argument was missing. Ask the caller to rephrase.',
      );
      return;
    }
    if (this.consultInFlight) {
      this.client.sendFunctionCallOutput(callId, CONSULT_BUSY_OUTPUT);
      return;
    }
    this.consultInFlight = true;
    this.options.onStateChange('thinking');
    void this.options
      .consultAgent(request, this.consultAbort.signal)
      .then((reply) => {
        return reply.trim() || 'The assistant returned no reply.';
      })
      .catch((error) => {
        if (this.consultAbort.signal.aborted) {
          return '';
        }
        this.options.onError(
          `Agent consult failed: ${String(
            error instanceof Error ? error.message : error,
          )}`,
        );
        return 'The assistant hit an error while working on that. Apologize to the caller and offer to try again.';
      })
      .then((output) => {
        this.consultInFlight = false;
        if (this.closed || !output) {
          return;
        }
        this.options.onStateChange('listening');
        this.client.sendFunctionCallOutput(callId, output);
      });
  }
}
