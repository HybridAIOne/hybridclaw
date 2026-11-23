import http from 'node:http';
import { expect, test } from 'vitest';
import type { ChatMessage } from '../src/types/api.js';
import { runContainerWorker } from './helpers/container-worker.js';
import { useTempDir } from './test-utils.js';

const makeTempDir = useTempDir('hc-failure-evidence-');

function completion(
  content: string | null,
  toolCalls?: NonNullable<ChatMessage['tool_calls']>,
) {
  return {
    id: 'test',
    choices: [
      {
        message: { role: 'assistant', content, tool_calls: toolCalls },
        finish_reason: toolCalls ? 'tool_calls' : 'stop',
      },
    ],
  };
}

const fetchReport = completion(null, [
  {
    id: 'fetch-report',
    type: 'function',
    function: {
      name: 'http_request',
      arguments: JSON.stringify({ url: 'https://example.com/report' }),
    },
  },
]);

test('a turn reports the provider call it resent and why its tool call failed', async () => {
  const workspace = makeTempDir();
  let modelRequests = 0;
  const server = http.createServer(async (req, res) => {
    for await (const _chunk of req);
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/http/request') {
      res.end(
        JSON.stringify({
          ok: false,
          status: 404,
          statusText: 'Not Found',
          url: 'https://example.com/report',
          body: 'No report here.',
        }),
      );
      return;
    }
    modelRequests += 1;
    if (modelRequests === 1) {
      res.statusCode = 503;
      res.end(JSON.stringify({ error: { message: 'Temporarily overloaded' } }));
      return;
    }
    res.end(
      JSON.stringify(
        modelRequests === 2 ? fetchReport : completion('There is no report.'),
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No address');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const output = await runContainerWorker(
      {
        sessionId: 'failure-evidence',
        messages: [{ role: 'user', content: 'Fetch the report.' }],
        apiKey: 'test-key',
        baseUrl,
        gatewayBaseUrl: baseUrl,
        provider: 'hybridai',
        model: 'test-model',
        chatbotId: 'test-bot',
        channelId: 'test-channel',
        enableRag: false,
        allowedTools: ['http_request'],
        approvalMode: 'full',
        ralphMaxIterations: 0,
        skipContainerSystemPrompt: true,
        contextWindow: 128_000,
      },
      {
        HYBRIDCLAW_AGENT_WORKSPACE_ROOT: workspace,
        HYBRIDCLAW_AGENT_ALLOWED_ROOTS: JSON.stringify([workspace]),
        HYBRIDCLAW_RETRY_ENABLED: 'true',
        HYBRIDCLAW_RETRY_BASE_DELAY_MS: '100',
        HYBRIDCLAW_RETRY_MAX_DELAY_MS: '100',
      },
    );

    expect(output).toMatchObject({
      status: 'success',
      result: 'There is no report.',
    });
    expect(modelRequests).toBe(3);
    expect(output.tokenUsage).toMatchObject({ modelCalls: 3, modelRetries: 1 });
    expect(
      output.tokenUsage?.modelUsage?.map((call) => call.usage.modelRetries),
    ).toEqual([0, 1, 0]);
    expect(output.toolExecutions).toMatchObject([
      { name: 'http_request', isError: true, errorCode: 'NOT_FOUND' },
    ]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 30_000);
