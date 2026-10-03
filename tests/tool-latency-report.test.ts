import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { useTempDir } from './test-utils.js';
// The unshipped benchmark is JavaScript, independent of runtime production types.
// @ts-expect-error -- standalone benchmark module has no declaration artifact.
import { summarize } from '../eval-harness/tool-latency/report.mjs';

const sample = { prompt: 'Example query', totalMs: 9000, status: 'success', workerState: 'warm' };
const tempDir = useTempDir();

describe('correctness-gated latency reports', () => {
  test('does not score ungraded answers as passing', () => {
    expect(summarize([sample])[0]).toMatchObject({ graded: 0, passRate: null, correctAndSub10s: 0, atLeastTenRuns: false });
  });

  test('includes incorrect and slow answers in the pass-rate denominator', () => {
    const runs = [
      { ...sample, correct: true },
      { ...sample, totalMs: 10_000, correct: true },
      { ...sample, totalMs: 5000, correct: false },
      { ...sample, totalMs: 1000, status: 'error', correct: true },
    ];
    expect(summarize(runs)[0]).toMatchObject({ runs: 4, graded: 4, correct: 2, correctAndSub10s: 1, passRate: 0.25, p50Ms: 5000, p90Ms: 10_000, correctLatency: { p50Ms: 9000, p90Ms: 10_000 } });
  });

  test('separates prompts and known cold/warm runs without inferring worker state', () => {
    const runs = Array.from({ length: 10 }, () => ({ ...sample, correct: true }));
    const report = summarize([...runs, { ...sample, workerState: 'cold' }, { ...sample, workerState: undefined }, { ...sample, prompt: 'Other query' }]);
    expect(report).toHaveLength(4);
    expect(report[0]).toMatchObject({ atLeastTenRuns: true, passRate: 1 });
    expect(report.map((group: { workerState: string }) => group.workerState)).toEqual(['warm', 'cold', 'unknown', 'warm']);
  });

  test.each([{ ...sample, correct: 'yes' }, { ...sample, totalMs: -1 }, { ...sample, workerState: 'fresh' }])('rejects invalid grading or metrics: %j', (row) => {
    expect(() => summarize([row])).toThrow();
  });

  test.each([
    { count: 10, correct: true, expected: 0 },
    { count: 10, correct: false, expected: 1 },
    { count: 10, correct: null, expected: 1 },
    { count: 1, correct: true, expected: 1 },
  ])('the CLI gates the target on grading and sample size: %j', ({ count, correct, expected }) => {
    const file = path.join(tempDir(), 'results.jsonl');
    const rows = Array.from({ length: count }, () => ({ ...sample, correct }));
    writeFileSync(file, [...rows, { type: 'summary' }].map(row => JSON.stringify(row)).join('\n'));
    const result = spawnSync(process.execPath, ['eval-harness/tool-latency/report.mjs', file], { encoding: 'utf8' });
    expect(result.status).toBe(expected);
    const summary = JSON.parse(result.stdout);
    expect(summary.type).toBe('summary');
    expect(summary.groups[0].runs).toBe(count);
  });
});
