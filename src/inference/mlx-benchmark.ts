/**
 * Local installation qualification exercises real streaming and tool round trips.
 * These small checks gate activation; they are not a general model ranking.
 */
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { detectMacHardware } from './local-model-catalog.js';
import { mlxCredentials, mlxHealth } from './mlx-runtime.js';

export async function benchmarkMlx(home: string) {
  const { baseUrl, token, installation } = mlxCredentials(home);
  const task = randomUUID();
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'X-HybridClaw-Task': task,
  };
  const start = performance.now();
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    redirect: 'error',
    signal: AbortSignal.timeout(120_000),
    body: JSON.stringify({
      model: installation.model,
      stream: true,
      stream_options: { include_usage: true },
      // 2026-09-10, Codex Spark qualification: reserve room for reasoning and
      // visible output; larger quality/context benchmarks remain separate.
      max_tokens: Math.min(512, installation.maxTokens),
      messages: [
        {
          role: 'user',
          content: 'Count from one to twenty in English, separated by commas.',
        },
      ],
    }),
  });
  if (!response.ok || !response.body)
    throw new Error(`Local streaming check failed (HTTP ${response.status}).`);
  let buffer = '';
  let firstTokenMs: number | null = null;
  let completionTokens = 0;
  let promptTokens = 0;
  let completed = false;
  let visibleOutput = false;
  const decoder = new TextDecoder();
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      if (line === 'data: [DONE]') {
        completed = true;
        continue;
      }
      const event = JSON.parse(line.slice(6)) as {
        error?: unknown;
        choices?: Array<{
          delta?: {
            content?: string;
            reasoning?: string;
            reasoning_content?: string;
          };
        }>;
        usage?: { completion_tokens: number; prompt_tokens: number };
      };
      if (event.error) throw new Error('Local streaming generation failed.');
      const delta = event.choices?.[0]?.delta;
      if (delta?.content) visibleOutput = true;
      if (
        (delta?.content || delta?.reasoning || delta?.reasoning_content) &&
        firstTokenMs === null
      )
        firstTokenMs = performance.now() - start;
      if (event.usage) {
        completionTokens = event.usage.completion_tokens;
        promptTokens = event.usage.prompt_tokens;
      }
    }
  }
  const elapsedMs = performance.now() - start;
  if (
    !completed ||
    !visibleOutput ||
    firstTokenMs === null ||
    !completionTokens
  )
    throw new Error('Incomplete local stream or missing token usage.');
  const messages: Array<Record<string, unknown>> = [
    {
      role: 'user',
      content:
        'Call local_probe with value "hybridclaw". Do not answer until the tool returns. Then repeat the tool result exactly.',
    },
  ];
  const tools = [
    {
      type: 'function',
      function: {
        name: 'local_probe',
        description: 'Required local verification tool.',
        parameters: {
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value'],
          additionalProperties: false,
        },
      },
    },
  ];
  async function chat() {
    const result = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(120_000),
      body: JSON.stringify({
        model: installation.model,
        messages,
        tools,
        max_tokens: 256,
        temperature: 0,
      }),
    });
    if (!result.ok)
      throw new Error(`Local tool check failed (HTTP ${result.status}).`);
    return (await result.json()) as {
      choices: Array<{
        message: {
          role: string;
          content?: string;
          tool_calls?: Array<{
            id: string;
            type: string;
            function: { name: string; arguments: string };
          }>;
        };
      }>;
    };
  }
  const first = (await chat()).choices?.[0]?.message;
  const call = first?.tool_calls?.[0];
  if (
    first?.tool_calls?.length !== 1 ||
    !call?.id ||
    call.type !== 'function' ||
    call.function.name !== 'local_probe' ||
    JSON.parse(call.function.arguments).value !== 'hybridclaw'
  ) {
    throw new Error(
      'The model did not produce the expected valid tool call; it was not activated.',
    );
  }
  const marker = `verified-${randomUUID()}`;
  messages.push(first as Record<string, unknown>, {
    role: 'tool',
    tool_call_id: call.id,
    content: marker,
  });
  const final = (await chat()).choices?.[0]?.message;
  if (!final?.content?.includes(marker) || final.tool_calls?.length)
    throw new Error(
      'The model did not complete the tool round trip; it was not activated.',
    );
  const health = await mlxHealth(home);
  if (
    health?.status !== 'ready' ||
    typeof health.peakMemoryBytes !== 'number' ||
    health.peakMemoryBytes > installation.memoryLimitBytes
  ) {
    throw new Error(
      'The model failed its health or memory check; it was not activated.',
    );
  }
  return {
    timestamp: new Date().toISOString(),
    hardware: detectMacHardware(),
    model: installation.model,
    repo: installation.repo,
    revision: installation.revision,
    engine: 'mlx-lm/0.31.3',
    contextWindow: installation.contextWindow,
    firstTokenMs: Math.round(firstTokenMs),
    elapsedMs: Math.round(elapsedMs),
    promptTokens,
    completionTokens,
    effectivePrefillTokensPerSecond: promptTokens / (firstTokenMs / 1000),
    effectiveDecodeTokensPerSecond:
      Math.max(0, completionTokens - 1) /
      Math.max(0.001, (elapsedMs - firstTokenMs) / 1000),
    toolRoundTripPassed: true,
    health,
    note: 'Single-run installation smoke test. Effective rates include HTTP overhead; not a quality benchmark.',
  };
}
