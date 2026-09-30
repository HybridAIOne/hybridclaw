/**
 * OpenAI-compatible model server whose replies come from the test, not a
 * model: every chat completion request is recorded and answered with the
 * assistant message `reply` returns for it. `GET …/models` lists one model so
 * a gateway's local-backend discovery accepts the endpoint.
 */
import http from 'node:http';
import type { ChatMessage, ToolDefinition } from '../../container/src/types.js';

export type ModelRequestBody = {
  messages: ChatMessage[];
  tools: ToolDefinition[];
};

export type ScriptedModelReply = (
  body: ModelRequestBody,
) => Record<string, unknown> | Promise<Record<string, unknown>>;

export async function startScriptedModelServer(
  reply: ScriptedModelReply,
  options: { host?: string; model?: string } = {},
): Promise<{
  server: http.Server;
  port: number;
  requests: ModelRequestBody[];
}> {
  const requests: ModelRequestBody[] = [];
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url?.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          object: 'list',
          data: [{ id: options.model ?? 'test', object: 'model' }],
        }),
      );
      return;
    }
    let text = '';
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text) as ModelRequestBody;
    requests.push(body);
    let message: Record<string, unknown>;
    try {
      message = await reply(body);
    } catch (error) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: String(error) } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'test',
        choices: [
          {
            message,
            finish_reason:
              message.finish_reason ??
              (message.tool_calls ? 'tool_calls' : 'stop'),
          },
        ],
      }),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, options.host ?? '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Missing test port');
  }
  return { server, port: address.port, requests };
}
