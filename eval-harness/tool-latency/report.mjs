/**
 * Latency reports retain failed and ungraded answers in the sample.
 * A human must check source evidence; timing and tool counts cannot establish
 * answer correctness. Missing verdicts never count as successful runs.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p) => sorted[Math.ceil(p * sorted.length) - 1] ?? null;
  return { p50Ms: percentile(0.5), p90Ms: percentile(0.9) };
}

export function summarize(samples) {
  const groups = new Map();
  for (const sample of samples) {
    if (
      typeof sample.prompt !== 'string' ||
      !Number.isFinite(sample.totalMs) ||
      sample.totalMs < 0
    ) {
      throw new Error('Each sample requires a prompt and nonnegative totalMs.');
    }
    if (sample.correct != null && typeof sample.correct !== 'boolean') {
      throw new Error('Correctness verdicts must be true, false, or null.');
    }
    const workerState = sample.workerState ?? 'unknown';
    if (!['cold', 'warm', 'unknown'].includes(workerState)) {
      throw new Error('Worker state must be cold, warm, or unknown.');
    }
    const key = JSON.stringify([sample.prompt, workerState]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(sample);
  }
  return [...groups.values()].map((runs) => {
    const graded = runs.filter((run) => typeof run.correct === 'boolean');
    const correct = runs.filter(
      (run) => run.status === 'success' && run.correct === true,
    );
    const passed = correct.filter((run) => run.totalMs < 10_000);
    return {
      prompt: runs[0].prompt,
      workerState: runs[0].workerState ?? 'unknown',
      runs: runs.length,
      atLeastTenRuns: runs.length >= 10,
      ...distribution(runs.map((run) => run.totalMs)),
      correctLatency: distribution(correct.map((run) => run.totalMs)),
      graded: graded.length,
      correct: correct.length,
      correctAndSub10s: passed.length,
      passRate:
        graded.length === runs.length ? passed.length / runs.length : null,
    };
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  if (!process.argv[2]) throw new Error('Usage: node report.mjs results.jsonl');
  const samples = readFileSync(process.argv[2], 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line))
    .filter((row) => row.type !== 'summary');
  if (!samples.length) throw new Error('No benchmark samples found.');
  const report = summarize(samples);
  console.log(JSON.stringify({ type: 'summary', groups: report }));
  if (report.some((group) => !group.atLeastTenRuns || group.passRate !== 1))
    process.exitCode = 1;
}
