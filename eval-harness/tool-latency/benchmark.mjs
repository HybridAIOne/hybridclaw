// Fresh, serial gateway turns measure user-visible latency, including startup.
// Correctness is assessed from the returned source-backed answer, not tool count.
import { randomUUID } from 'node:crypto';
import { readStoredRuntimeSecret } from '../../dist/security/runtime-secrets.js';

const runs = Number(process.argv[2] || 3);
if (!Number.isSafeInteger(runs) || runs < 1 || runs > 10) {
  throw new Error(
    'Usage: node eval-harness/tool-latency/benchmark.mjs [runs: 1–10]',
  );
}
const baseUrl = process.env.GATEWAY_URL || 'http://127.0.0.1:9090';
const token =
  process.env.GATEWAY_API_TOKEN || readStoredRuntimeSecret('GATEWAY_API_TOKEN');
if (!token) throw new Error('An authenticated gateway API token is required.');

const prompts = [
  'Welche Proteinriegel im dm haben den höchsten Proteingehalt absolut in g?',
  'Welche Aktionen gibt es gerade bei dm?',
];
for (const prompt of prompts) {
  for (let run = 1; run <= runs; run++) {
    const sessionId = `bench_latency_${randomUUID()}`;
    const start = performance.now();
    const response = await fetch(new URL('/api/chat', baseUrl), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/x-ndjson',
      },
      body: JSON.stringify({
        sessionId,
        userId: 'benchmark-user',
        content: prompt,
        stream: true,
        ...(process.env.BENCH_AGENT_ID
          ? { agentId: process.env.BENCH_AGENT_ID }
          : {}),
        ...(process.env.BENCH_MODEL ? { model: process.env.BENCH_MODEL } : {}),
      }),
      signal: AbortSignal.timeout(180_000),
    });
    if (!response.ok)
      throw new Error(`Gateway returned HTTP ${response.status}`);
    let buffer = '';
    let result;
    const tools = [];
    const accept = (line) => {
      if (!line.trim()) return;
      const event = JSON.parse(line);
      if (event.type === 'tool' && event.phase === 'finish') {
        tools.push({ name: event.toolName, ms: event.durationMs });
      }
      if (event.type === 'result') result = event.result;
      if (event.type === 'error')
        throw new Error('Gateway reported a failed benchmark turn.');
    };
    const decoder = new TextDecoder();
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        accept(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
      }
    }
    buffer += decoder.decode();
    accept(buffer);
    if (!result) throw new Error('Gateway stream ended without a result.');
    console.log(
      JSON.stringify({
        prompt,
        run,
        sessionId,
        totalMs: Math.round(performance.now() - start),
        status: result.status,
        model: result.model,
        tools,
        promptTokens: result.tokenUsage?.apiPromptTokens,
        answer: result.result || result.content || result.response,
      }),
    );
  }
}
