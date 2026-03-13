import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

let workspaceRoot = '';

function writeTranscript(
  root: string,
  sessionId: string,
  rows: Array<{ role: string; content: string }>,
): void {
  const transcriptDir = path.join(root, '.session-transcripts');
  fs.mkdirSync(transcriptDir, { recursive: true });
  const lines = rows.map((row, index) =>
    JSON.stringify({
      sessionId,
      role: row.role,
      content: row.content,
      createdAt: new Date(1_700_000_000_000 + index * 1_000).toISOString(),
    }),
  );
  fs.writeFileSync(
    path.join(transcriptDir, `${sessionId}.jsonl`),
    `${lines.join('\n')}\n`,
    'utf-8',
  );
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
  if (workspaceRoot) {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
    workspaceRoot = '';
  }
});

test('session_search upgrades summaries with the auxiliary session_search task model', async () => {
  workspaceRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-session-search-'),
  );
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', workspaceRoot);
  writeTranscript(workspaceRoot, 'session-a', [
    { role: 'user', content: 'Need a release plan for the next deployment.' },
    {
      role: 'assistant',
      content:
        'We planned the release with a Friday cutoff and a rollback checklist.',
    },
  ]);

  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    expect(input).toBe('http://127.0.0.1:8000/v1/chat/completions');
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              role: 'assistant',
              content:
                'User wanted a release plan. We agreed on a Friday cutoff and a rollback checklist.',
            },
          },
        ],
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  });
  vi.stubGlobal('fetch', fetchMock);

  const { executeToolWithMetadata, setModelContext, setTaskModelPolicies } =
    await import('../container/src/tools.js');
  setModelContext(
    'hybridai',
    'https://hybridai.one',
    'test-key',
    'gpt-5-nano',
    'bot_123',
    {},
  );
  setTaskModelPolicies({
    session_search: {
      provider: 'vllm',
      baseUrl: 'http://127.0.0.1:8000/v1',
      apiKey: '',
      model: 'vllm/mistral-small',
      chatbotId: '',
      requestHeaders: {},
      isLocal: true,
      maxTokens: 444,
    },
  });

  const result = await executeToolWithMetadata(
    'session_search',
    JSON.stringify({ query: 'release plan', useLlmSummary: true }),
  );

  expect(result.isError).toBe(false);
  const parsed = JSON.parse(result.output) as {
    count: number;
    results: Array<{ summary: string }>;
  };
  expect(parsed.count).toBe(1);
  expect(parsed.results[0]?.summary).toContain('Friday cutoff');
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test('web_extract applies auxiliary web processing by default', async () => {
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input === 'https://example.com/article') {
        return new Response(
          '<html><head><title>Example Article</title></head><body><main><h1>Example Article</h1><p>Important release detail.</p><p>Second paragraph with commands and URLs.</p></main></body></html>',
          {
            status: 200,
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
          },
        );
      }
      expect(input).toBe('http://127.0.0.1:8000/v1/chat/completions');
      const body = JSON.parse(String(init?.body || '{}')) as Record<
        string,
        unknown
      >;
      expect(body.model).toBe('mistral-small');
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: 'assistant',
                content:
                  '## Summary\n- Important release detail.\n- Preserved commands and URLs.\n',
              },
            },
          ],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    },
  );
  vi.stubGlobal('fetch', fetchMock);

  const { executeToolWithMetadata, setModelContext, setTaskModelPolicies } =
    await import('../container/src/tools.js');
  setModelContext(
    'hybridai',
    'https://hybridai.one',
    'test-key',
    'gpt-5-nano',
    'bot_123',
    {},
  );
  setTaskModelPolicies({
    web_extract: {
      provider: 'vllm',
      baseUrl: 'http://127.0.0.1:8000/v1',
      apiKey: '',
      model: 'vllm/mistral-small',
      chatbotId: '',
      requestHeaders: {},
      isLocal: true,
      maxTokens: 555,
    },
  });

  const result = await executeToolWithMetadata(
    'web_extract',
    JSON.stringify({ url: 'https://example.com/article' }),
  );

  expect(result.isError).toBe(false);
  expect(result.output).toContain('LLM processing: applied');
  expect(result.output).toContain('## Summary');
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
