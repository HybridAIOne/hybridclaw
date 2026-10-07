import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { describe, expect, test, vi } from 'vitest';
import {
  BehaviorAnomalyReranker,
  buildBehaviorTuple,
} from '../container/src/behavior-anomaly.js';
import { writeBehaviorTrajectoryStore } from './helpers/behavior-trajectory-store.js';
import { useCleanMocks, useTempDir } from './test-utils.js';

const READ_CALL = {
  toolName: 'read',
  args: { path: '/workspace/docs/readme.md' },
};

describe('behavior anomaly reranker', () => {
  const makeTempDir = useTempDir('hybridclaw-anomaly-');
  useCleanMocks({ restoreAllMocks: true });

  test.each([
    ['hybridai__dm__getProductDetails', { id: 1 }, ['call', 'unknown']],
    ['read', { path: '/workspace/a.md' }, ['call', 'workspace']],
    ['bash', { command: 'npm install left-pad' }, ['install', 'unknown']],
    ['bash', { command: 'rm -rf /tmp/x' }, ['delete', 'scratch']],
    ['bash', { command: 'curl https://example.com' }, ['network', 'network']],
    ['bash', { command: 'ls -la src' }, ['command', 'unknown']],
  ])('tuple for %s %j is (action, target, tool)', (toolName, args, fields) => {
    expect(buildBehaviorTuple({ toolName, args }).split('\u001f')).toEqual([
      ...fields,
      toolName.toLowerCase(),
    ]);
  });

  test('abstains during cold start', () => {
    const storeDir = makeTempDir();
    writeBehaviorTrajectoryStore({ storeDir, agentId: 'lena', count: 3 });
    const reranker = new BehaviorAnomalyReranker({
      storeDir,
      agentId: 'lena',
      minTrajectories: 50,
      cacheTtlMs: 0,
    });

    const score = reranker.score(READ_CALL);

    expect(score.status).toBe('abstained');
    expect(score.reason).toContain('3/50 approved trajectories available');
  });

  test('cached scoring stays under 5ms per call', () => {
    const storeDir = makeTempDir();
    writeBehaviorTrajectoryStore({ storeDir, agentId: 'lena', count: 80 });
    const reranker = new BehaviorAnomalyReranker({
      storeDir,
      agentId: 'lena',
      minTrajectories: 50,
    });

    reranker.score(READ_CALL);
    const startedAt = performance.now();
    for (let index = 0; index < 100; index += 1) {
      reranker.score(READ_CALL);
    }
    const avgMs = (performance.now() - startedAt) / 100;

    expect(avgMs).toBeLessThan(5);
  });

  test('reloads when cache expires and store changes', () => {
    const storeDir = makeTempDir();
    writeBehaviorTrajectoryStore({ storeDir, agentId: 'lena', count: 3 });
    const reranker = new BehaviorAnomalyReranker({
      storeDir,
      agentId: 'lena',
      minTrajectories: 50,
      cacheTtlMs: 0,
    });

    expect(reranker.score(READ_CALL).trajectoryCount).toBe(3);

    writeBehaviorTrajectoryStore({ storeDir, agentId: 'lena', count: 80 });

    expect(reranker.score(READ_CALL).trajectoryCount).toBe(80);
  });

  test('a reload re-reads only the trajectory files that changed', () => {
    const storeDir = makeTempDir();
    writeBehaviorTrajectoryStore({
      storeDir,
      agentId: 'lena',
      count: 40,
      date: '2026-04-30',
    });
    const today = writeBehaviorTrajectoryStore({
      storeDir,
      agentId: 'lena',
      count: 40,
      date: '2026-05-01',
    });
    const reranker = new BehaviorAnomalyReranker({
      storeDir,
      agentId: 'lena',
      minTrajectories: 50,
      cacheTtlMs: 0,
    });
    expect(reranker.score(READ_CALL).trajectoryCount).toBe(80);
    const readFile = vi.spyOn(fs, 'readFileSync');

    expect(reranker.score(READ_CALL).trajectoryCount).toBe(80);
    expect(readFile).not.toHaveBeenCalled();

    writeBehaviorTrajectoryStore({
      storeDir,
      agentId: 'lena',
      count: 5,
      date: '2026-05-01',
      append: true,
    });

    expect(reranker.score(READ_CALL).trajectoryCount).toBe(85);
    expect(readFile.mock.calls.map(([file]) => file)).toEqual([today]);
  });

  test("trains only on the agent's own file and its own records", () => {
    const storeDir = makeTempDir();
    // `a.b` and `a_b` sanitize to the same file name.
    writeBehaviorTrajectoryStore({
      storeDir,
      agentId: 'a.b',
      count: 80,
      fileName: 'a_b.jsonl',
    });
    writeBehaviorTrajectoryStore({
      storeDir,
      agentId: 'a_b',
      count: 3,
      append: true,
    });
    writeBehaviorTrajectoryStore({
      storeDir,
      agentId: 'a_b',
      count: 80,
      fileName: 'other.jsonl',
    });
    const reranker = new BehaviorAnomalyReranker({
      storeDir,
      agentId: 'a_b',
      minTrajectories: 50,
    });

    expect(reranker.score(READ_CALL).trajectoryCount).toBe(3);
  });

  test('applies F11 anomalous verdict on replay', () => {
    const storeDir = makeTempDir();
    writeBehaviorTrajectoryStore({ storeDir, agentId: 'lena', count: 80 });
    const reranker = new BehaviorAnomalyReranker({
      storeDir,
      agentId: 'lena',
      minTrajectories: 50,
      epsilon: 1,
    });

    const borderline = reranker.score(READ_CALL);
    expect(borderline.status).toBe('borderline');
    reranker.recordTraceJudgeResult(borderline.tuple, {
      verdict: 'anomalous',
      score: 0.82,
      reason: 'unusual for this agent',
    });
    const replay = reranker.score(READ_CALL);

    expect(replay.status).toBe('scored');
    expect(replay.score).toBeGreaterThan(replay.threshold || 0);
    expect(replay.traceJudge).toEqual({
      verdict: 'anomalous',
      score: 0.82,
      reason: 'unusual for this agent',
    });
  });
});
