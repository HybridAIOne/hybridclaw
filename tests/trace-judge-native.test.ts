import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

import {
  TRACE_JUDGE_EVAL_CRITERION_TYPES,
  TRACE_JUDGE_EVAL_DATASET,
} from '../src/evals/trace-judge-eval-dataset.ts';
import {
  runTraceJudgeNativeCli,
  runTraceJudgeNativeEval,
} from '../src/evals/trace-judge-native.ts';

test('trace judge eval dataset covers at least 150 balanced labeled examples', () => {
  expect(TRACE_JUDGE_EVAL_DATASET.length).toBeGreaterThanOrEqual(150);
  for (const criterionType of TRACE_JUDGE_EVAL_CRITERION_TYPES) {
    const examples = TRACE_JUDGE_EVAL_DATASET.filter(
      (example) => example.criterionType === criterionType,
    );
    const verdictCounts = {
      pass: examples.filter((example) => example.expectedVerdict === 'pass')
        .length,
      partial: examples.filter(
        (example) => example.expectedVerdict === 'partial',
      ).length,
      fail: examples.filter((example) => example.expectedVerdict === 'fail')
        .length,
    };
    expect(examples.length).toBeGreaterThanOrEqual(30);
    expect(verdictCounts.pass).toBeGreaterThanOrEqual(10);
    expect(verdictCounts.partial).toBeGreaterThanOrEqual(10);
    expect(verdictCounts.fail).toBeGreaterThanOrEqual(10);
    expect(verdictCounts.pass).toBe(verdictCounts.partial);
    expect(verdictCounts.partial).toBe(verdictCounts.fail);
  }
});

test('trace judge native offline gate reports per-criterion metrics and artifacts', async () => {
  const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-judge-eval-'));

  const summary = await runTraceJudgeNativeEval({
    mode: 'offline',
    model: null,
    maxExamples: null,
    criterionType: null,
    jobDir,
    minExamples: 150,
    minPrecision: 0.95,
    minRecall: 0.95,
    minF1: 0.95,
  });

  expect(summary.passed).toBe(true);
  expect(summary.datasetExamples).toBe(TRACE_JUDGE_EVAL_DATASET.length);
  expect(summary.datasetExamples).toBeGreaterThanOrEqual(150);
  expect(summary.overall).toMatchObject({
    precision: 1,
    recall: 1,
    f1: 1,
  });
  expect(summary.criteria.map((metric) => metric.criterionType)).toEqual(
    TRACE_JUDGE_EVAL_CRITERION_TYPES,
  );
  expect(fs.existsSync(summary.predictionsPath)).toBe(true);
  expect(fs.existsSync(summary.resultPath)).toBe(true);
});

test('trace judge native gate fails when minimum example count is not met', async () => {
  const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-judge-small-'));

  const summary = await runTraceJudgeNativeEval({
    mode: 'offline',
    model: null,
    maxExamples: 10,
    criterionType: null,
    jobDir,
    minExamples: 150,
    minPrecision: 0.95,
    minRecall: 0.95,
    minF1: 0.95,
  });

  expect(summary.passed).toBe(false);
  expect(summary.datasetExamples).toBe(10);
});

test('trace judge eval dataset does not expose verdict marker shortcuts', () => {
  const serialized = JSON.stringify(TRACE_JUDGE_EVAL_DATASET);
  expect(serialized).not.toContain('evidenceState');
  expect(serialized).not.toContain('classified_with_approval_and_mitigation');
  expect(serialized).not.toContain('risk_not_classified');
  expect(serialized).not.toContain('all_sensitive_values_redacted');
  expect(serialized).not.toContain('voice_guide_matched');
  expect(serialized).not.toContain('required_tools_used_and_verified');
  expect(serialized).not.toContain('all_deliverables_complete');
});

test('trace judge native cli fails fast on invalid live args', async () => {
  await expect(runTraceJudgeNativeCli(['--live'])).rejects.toThrow(
    /requires --model/,
  );
  await expect(runTraceJudgeNativeCli(['--min-f1', '1.5'])).rejects.toThrow(
    /between 0 and 1/,
  );
});
