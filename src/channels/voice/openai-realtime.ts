/**
 * OpenAI Realtime API websocket client for speech-to-speech phone calls.
 *
 * Owns the upstream socket lifecycle and the GA realtime event vocabulary
 * (`session.update`, `input_audio_buffer.append`, `response.*`), surfacing a
 * typed callback seam so callers never touch raw realtime JSON. Audio stays
 * base64 µ-law end to end — this module never transcodes.
 *
 * NOT the call bridge (`realtime-bridge.ts` decides *what* to do with events);
 * this module only guarantees a validated, ordered event stream.
 */
import WebSocket from 'ws';
import { isRecord } from '../../utils/type-guards.js';

const OPENAI_REALTIME_URL = 'wss://api.openai.com/v1/realtime';
const SOCKET_OPEN = 1;

export interface RealtimeFunctionTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface RealtimeFunctionCall {
  callId: string;
  name: string;
  arguments: string;
}

export interface OpenAIRealtimeCallbacks {
  onReady: () => void;
  onAudioDelta: (base64Audio: string) => void;
  onSpeechStarted: () => void;
  onInputTranscript: (transcript: string) => void;
  onOutputTranscript: (transcript: string) => void;
  onFunctionCall: (call: RealtimeFunctionCall) => void;
  onError: (message: string) => void;
  onClosed: () => void;
}

export interface RealtimeSocket {
  on(event: 'open', listener: () => void): void;
  on(event: 'message', listener: (data: WebSocket.Data) => void): void;
  on(event: 'close', listener: () => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  send(data: string, cb?: (error?: Error) => void): void;
  close(): void;
  readyState: number;
}

export type RealtimeSocketFactory = (
  url: string,
  headers: Record<string, string>,
) => RealtimeSocket;

const defaultSocketFactory: RealtimeSocketFactory = (url, headers) =>
  new WebSocket(url, { headers }) as unknown as RealtimeSocket;

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export interface OpenAIRealtimeClientOptions {
  apiKey: string;
  model: string;
  voice: string;
  instructions: string;
  tools: RealtimeFunctionTool[];
  callbacks: OpenAIRealtimeCallbacks;
  socketFactory?: RealtimeSocketFactory;
}

export class OpenAIRealtimeClient {
  private readonly socket: RealtimeSocket;
  private readonly callbacks: OpenAIRealtimeCallbacks;
  private responseActive = false;
  private closed = false;

  constructor(options: OpenAIRealtimeClientOptions) {
    this.callbacks = options.callbacks;
    const factory = options.socketFactory || defaultSocketFactory;
    const url = `${OPENAI_REALTIME_URL}?model=${encodeURIComponent(options.model)}`;
    this.socket = factory(url, {
      Authorization: `Bearer ${options.apiKey}`,
    });
    this.socket.on('open', () => {
      this.sendEvent({
        type: 'session.update',
        session: {
          type: 'realtime',
          output_modalities: ['audio'],
          instructions: options.instructions,
          audio: {
            input: {
              format: { type: 'audio/pcmu' },
              transcription: { model: 'gpt-4o-mini-transcribe' },
              turn_detection: { type: 'server_vad' },
            },
            output: {
              format: { type: 'audio/pcmu' },
              voice: options.voice,
            },
          },
          tools: options.tools.map((tool) => ({
            type: 'function',
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          })),
          tool_choice: 'auto',
        },
      });
    });
    this.socket.on('message', (data) => {
      this.handleServerEvent(data);
    });
    this.socket.on('close', () => {
      this.closed = true;
      this.callbacks.onClosed();
    });
    this.socket.on('error', (error) => {
      this.callbacks.onError(error.message);
    });
  }

  get isOpen(): boolean {
    return !this.closed && this.socket.readyState === SOCKET_OPEN;
  }

  get hasActiveResponse(): boolean {
    return this.responseActive;
  }

  appendAudio(base64Audio: string): void {
    if (!base64Audio) return;
    this.sendEvent({ type: 'input_audio_buffer.append', audio: base64Audio });
  }

  createResponse(instructions?: string): void {
    this.sendEvent({
      type: 'response.create',
      ...(instructions ? { response: { instructions } } : {}),
    });
  }

  cancelResponse(): void {
    if (!this.responseActive) return;
    this.sendEvent({ type: 'response.cancel' });
    this.responseActive = false;
  }

  sendFunctionCallOutput(callId: string, output: string): void {
    this.sendEvent({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: callId,
        output,
      },
    });
    this.createResponse();
  }

  sendUserText(text: string): void {
    this.sendEvent({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text }],
      },
    });
    this.createResponse();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.close();
  }

  private sendEvent(event: Record<string, unknown>): void {
    if (this.closed || this.socket.readyState !== SOCKET_OPEN) {
      return;
    }
    this.socket.send(JSON.stringify(event), (error) => {
      if (error) {
        this.callbacks.onError(error.message);
      }
    });
  }

  private handleServerEvent(data: WebSocket.Data): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        typeof data === 'string'
          ? data
          : Buffer.from(data as Buffer).toString('utf8'),
      ) as unknown;
    } catch {
      this.callbacks.onError('Realtime server event was not valid JSON.');
      return;
    }
    if (!isRecord(parsed)) {
      this.callbacks.onError('Realtime server event was not a JSON object.');
      return;
    }
    const type = normalizeString(parsed.type);
    if (type === 'session.updated') {
      this.callbacks.onReady();
      return;
    }
    if (type === 'response.created') {
      this.responseActive = true;
      return;
    }
    if (type === 'response.done') {
      this.responseActive = false;
      return;
    }
    if (type === 'response.output_audio.delta') {
      const delta = normalizeString(parsed.delta);
      if (delta) {
        this.callbacks.onAudioDelta(delta);
      }
      return;
    }
    if (type === 'input_audio_buffer.speech_started') {
      this.callbacks.onSpeechStarted();
      return;
    }
    if (type === 'conversation.item.input_audio_transcription.completed') {
      const transcript = normalizeString(parsed.transcript).trim();
      if (transcript) {
        this.callbacks.onInputTranscript(transcript);
      }
      return;
    }
    if (type === 'response.output_audio_transcript.done') {
      const transcript = normalizeString(parsed.transcript).trim();
      if (transcript) {
        this.callbacks.onOutputTranscript(transcript);
      }
      return;
    }
    if (type === 'response.function_call_arguments.done') {
      this.callbacks.onFunctionCall({
        callId: normalizeString(parsed.call_id),
        name: normalizeString(parsed.name),
        arguments: normalizeString(parsed.arguments),
      });
      return;
    }
    if (type === 'error') {
      const error = isRecord(parsed.error) ? parsed.error : {};
      this.callbacks.onError(
        normalizeString(error.message) || 'Unknown realtime error',
      );
    }
  }
}
