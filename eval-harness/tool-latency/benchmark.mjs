// Fresh, serial gateway turns measure user-visible latency, including startup.
// Correctness is assessed from the returned source-backed answer, not tool count.
import { randomUUID } from 'node:crypto';
import { readStoredRuntimeSecret } from '../../dist/security/runtime-secrets.js';
import { summarize } from './report.mjs';

const runs = Number(process.argv[2] || 10);
if (!Number.isSafeInteger(runs) || runs < 1 || runs > 100) {
  throw new Error(
    'Usage: node eval-harness/tool-latency/benchmark.mjs [runs: 1–100]',
  );
}
const baseUrl = process.env.GATEWAY_URL || 'http://127.0.0.1:9090';
const token =
  process.env.GATEWAY_API_TOKEN || readStoredRuntimeSecret('GATEWAY_API_TOKEN');
if (!token) throw new Error('An authenticated gateway API token is required.');
const workerState = process.env.BENCH_WORKER_STATE || 'unknown';
if (!['cold', 'warm', 'unknown'].includes(workerState))
  throw new Error('BENCH_WORKER_STATE must be cold, warm, or unknown.');
const samples = [];

const prompts = [
  'Welche Proteinriegel im dm haben den höchsten Proteingehalt absolut in g?',
  'Welche Aktionen gibt es gerade bei dm?',
];
for (const prompt of prompts) {
  for (let run = 1; run <= runs; run++) {
    const sessionId = `bench_latency_${randomUUID()}`;
    const start = performance.now();
    let result;
    const tools = [];
    let failed = false;
    try {
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
          ...(process.env.BENCH_MODEL
            ? { model: process.env.BENCH_MODEL }
            : {}),
        }),
        signal: AbortSignal.timeout(180_000),
      });
      if (!response.ok)
        throw new Error(`Gateway returned HTTP ${response.status}`);
      let buffer = '';
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
    } catch {
      // Preserve failed attempts in the denominator without logging secrets.
      failed = true;
      process.exitCode = 1;
    }
    const sample = {
      type: 'sample',
      prompt,
      run,
      sessionId,
      totalMs: Math.round(performance.now() - start),
      status: failed ? 'error' : result.status,
      model: result?.model,
      tools,
      toolCounts: Object.fromEntries(
        [...new Set(tools.map((tool) => tool.name))].map((name) => [
          name,
          tools.filter((tool) => tool.name === name).length,
        ]),
      ),
      modelResponses: result?.tokenUsage?.modelCalls ?? null,
      promptTokens: result?.tokenUsage?.apiPromptTokens,
      workerState,
      correct: null,
      answer: result?.result || result?.content || result?.response,
    };
    samples.push(sample);
    console.log(JSON.stringify(sample));
  }
}
console.log(JSON.stringify({ type: 'summary', groups: summarize(samples) }));
