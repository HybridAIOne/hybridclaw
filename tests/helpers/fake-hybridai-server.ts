/**
 * A local stand-in for the HybridAI platform that speaks the two wire
 * protocols a gateway uses during a phone call: OpenAI-compatible
 * `/v1/chat/completions` (streamed SSE) for agent turns, and the OpenAI
 * realtime websocket at `/v1/realtime` for speech-to-speech sessions.
 *
 * Records what the gateway sent so e2e tests can assert on it. NOT a model:
 * every chat turn answers with `reply`, and the realtime side only speaks
 * the audio a test hands it.
 */
import { createServer, type IncomingMessage } from 'node:http';
import { type WebSocket, WebSocketServer } from 'ws';

export interface FakeHybridAIServer {
  url: string;
  reply: string;
  chatRequests: Array<{ model: string; lastUserMessage: string }>;
  realtime: {
    connections: number;
    sessionUpdates: Array<Record<string, unknown>>;
    appendedAudio: Buffer[];
    functionOutputs: string[];
  };
  /** Model audio (µ-law) the fake realtime model speaks for each response. */
  greetingAudio: Buffer;
  /** Has the realtime model call `consult_agent` with this request. */
  triggerConsult(request: string): void;
  close(): Promise<void>;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

function lastUserMessage(body: Record<string, unknown>): string {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: string; content?: unknown };
    if (message.role !== 'user') continue;
    if (typeof message.content === 'string') return message.content;
    if (Array.isArray(message.content)) {
      return message.content
        .map((part: { text?: string }) => part.text || '')
        .join('');
    }
  }
  return '';
}

function chunk(model: string, delta: Record<string, unknown>, finish?: string) {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-fake',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finish ?? null }],
  })}\n\n`;
}

export async function startFakeHybridAIServer(
  port: number,
): Promise<FakeHybridAIServer> {
  let realtimeSocket: WebSocket | null = null;
  let responseCount = 0;
  const state: FakeHybridAIServer = {
    url: `http://127.0.0.1:${port}`,
    reply: 'Hello **from** the agent. The weather is sunny today.',
    chatRequests: [],
    realtime: {
      connections: 0,
      sessionUpdates: [],
      appendedAudio: [],
      functionOutputs: [],
    },
    greetingAudio: Buffer.alloc(0),
    triggerConsult(request) {
      realtimeSocket?.send(
        JSON.stringify({
          type: 'response.function_call_arguments.done',
          call_id: 'call_consult_1',
          name: 'consult_agent',
          arguments: JSON.stringify({ request }),
        }),
      );
    },
    close: async () => {},
  };

  const server = createServer(async (req, res) => {
    const body = req.method === 'POST' ? await readJson(req) : {};
    if (req.url?.startsWith('/v1/chat/completions')) {
      const model = String(body.model || 'fake-model');
      state.chatRequests.push({ model, lastUserMessage: lastUserMessage(body) });
      if (!body.stream) {
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            id: 'chatcmpl-fake',
            object: 'chat.completion',
            model,
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: state.reply },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
          }),
        );
        return;
      }
      res.setHeader('content-type', 'text/event-stream');
      res.write(chunk(model, { role: 'assistant', content: '' }));
      for (const piece of state.reply.match(/.{1,12}/gs) || []) {
        res.write(chunk(model, { content: piece }));
      }
      res.write(chunk(model, {}, 'stop'));
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    res.statusCode = 404;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'not found in fake HybridAI' }));
  });

  const websockets = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    if (!req.url?.startsWith('/v1/realtime')) {
      socket.destroy();
      return;
    }
    websockets.handleUpgrade(req, socket, head, (ws) => {
      state.realtime.connections += 1;
      realtimeSocket = ws;
      ws.on('message', (raw) => {
        const event = JSON.parse(String(raw)) as Record<string, unknown>;
        if (event.type === 'session.update') {
          state.realtime.sessionUpdates.push(event);
          ws.send(JSON.stringify({ type: 'session.updated' }));
          return;
        }
        if (event.type === 'input_audio_buffer.append') {
          state.realtime.appendedAudio.push(
            Buffer.from(String(event.audio), 'base64'),
          );
          return;
        }
        if (event.type === 'conversation.item.create') {
          const item = event.item as { type?: string; output?: string };
          if (item?.type === 'function_call_output') {
            state.realtime.functionOutputs.push(String(item.output));
          }
          return;
        }
        if (event.type === 'response.create') {
          const id = `resp_${++responseCount}`;
          ws.send(JSON.stringify({ type: 'response.created', response: { id } }));
          ws.send(
            JSON.stringify({
              type: 'response.output_audio.delta',
              response_id: id,
              delta: state.greetingAudio.toString('base64'),
            }),
          );
          ws.send(
            JSON.stringify({
              type: 'response.output_audio_transcript.done',
              transcript: 'Hello from the fake realtime model.',
            }),
          );
          ws.send(JSON.stringify({ type: 'response.done', response: { id } }));
        }
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  state.close = () =>
    new Promise<void>((resolve) => {
      for (const client of websockets.clients) client.terminate();
      websockets.close();
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return state;
}
