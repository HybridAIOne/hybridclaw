import path from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { TrustedAgentApprovalRuntime } from '../container/src/approval-policy.js';
import {
  BehaviorAnomalyReranker,
  buildBehaviorTuple,
} from '../container/src/behavior-anomaly.js';
import {
  type BehaviorTrajectoryTool,
  writeBehaviorTrajectoryStore,
} from './helpers/behavior-trajectory-store.js';
import { useCleanMocks, useTempDir } from './test-utils.js';

const AGENT_ID = 'example-agent';
const READ_CALL = {
  toolName: 'read',
  args: { path: '/workspace/src/example.ts' },
};
const UNSEEN_CALL = {
  toolName: 'write',
  args: { path: '/tmp/example-output.txt', content: 'example' },
};

// Synthetic code, research and browser workflows with a long tail of occasional
// tools. Different file names still share the scorer's workspace-read category.
function writeDiverseBaseline(
  storeDir: string,
  scale = 1,
  append = false,
): void {
  const workflows: Array<{ count: number; tools: BehaviorTrajectoryTool[] }> = [
    {
      count: 28,
      tools: [
        { name: 'glob', args: { pattern: 'src/**/*.ts' } },
        { name: 'grep', args: { pattern: 'TODO' } },
        ...Array.from({ length: 8 }, (_, index) => ({
          name: 'read',
          args: { path: `/workspace/src/module-${index}.ts` },
        })),
        { name: 'edit', args: { path: '/workspace/src/example.ts' } },
        { name: 'bash', args: { command: 'npm test' } },
        { name: 'bash', args: { command: 'git diff' } },
      ],
    },
    {
      count: 10,
      tools: [
        { name: 'web_search', args: { query: 'example documentation' } },
        { name: 'web_fetch', args: { url: 'https://example.com/docs' } },
        { name: 'read', args: { path: '/tmp/example-notes.txt' } },
        { name: 'write', args: { path: '/workspace/research.txt' } },
      ],
    },
    {
      count: 5,
      tools: [
        { name: 'browser_navigate', args: { url: 'https://example.com' } },
        { name: 'browser_snapshot', args: {} },
        { name: 'browser_click', args: { ref: 'example-button' } },
        { name: 'browser_snapshot', args: {} },
      ],
    },
    {
      count: 2,
      tools: [
        { name: 'bash', args: { command: 'git status' } },
        { name: 'read', args: { path: '/workspace/config.json' } },
        { name: 'glob', args: { pattern: 'docs/**/*.md' } },
      ],
    },
    ...[
      { name: 'memory', args: { action: 'search', query: 'example' } },
      { name: 'http_request', args: { url: 'https://example.com/api' } },
      { name: 'browser_screenshot', args: {} },
      { name: 'image_generate', args: { prompt: 'A blue square' } },
      { name: 'skills_list', args: {} },
    ].map((tool) => ({
      count: 1,
      tools: [
        tool,
        { name: 'read', args: { path: '/workspace/notes.txt' } },
        { name: 'write', args: { path: '/workspace/summary.txt' } },
      ],
    })),
  ];
  for (const [index, workflow] of workflows.entries()) {
    writeBehaviorTrajectoryStore({
      storeDir,
      agentId: AGENT_ID,
      count: workflow.count * scale,
      tools: workflow.tools,
      append: append || index > 0,
    });
  }
}

describe('behavior anomaly scoring with a diverse baseline', () => {
  const makeTempDir = useTempDir('hybridclaw-diverse-anomaly-');
  useCleanMocks({ unstubAllEnvs: true });

  test.each(
    [1, 2, 8].flatMap((scale) => [
      { scale, previousReads: 0 },
      { scale, previousReads: 2 },
    ]),
  )(
    'directly scores an unseen call with $scale baseline copies and $previousReads prior reads',
    ({ scale, previousReads }) => {
      const storeDir = makeTempDir();
      writeDiverseBaseline(storeDir, scale);
      const reranker = new BehaviorAnomalyReranker({
        storeDir,
        agentId: AGENT_ID,
      });
      for (let index = 0; index < previousReads; index++) {
        reranker.recordApprovedTuple(buildBehaviorTuple(READ_CALL));
      }

      const result = reranker.score(UNSEEN_CALL);

      expect(result.trajectoryCount).toBe(50 * scale);
      expect(result.threshold).toBeGreaterThan(0.98);
      expect(result.status).toBe('scored');
      expect(result.score).toBeGreaterThan(result.threshold!);
      expect(result.score).toBeLessThan(1);
      expect(result.traceJudge).toBeUndefined();
    },
  );

  test('keeps familiar calls below threshold and threshold ties borderline', () => {
    const storeDir = makeTempDir();
    writeDiverseBaseline(storeDir);
    const reranker = new BehaviorAnomalyReranker({
      storeDir,
      agentId: AGENT_ID,
    });

    const familiar = reranker.score(READ_CALL);
    expect(familiar.status).toBe('scored');
    expect(familiar.score).toBeLessThan(familiar.threshold!);
    const nearThreshold = reranker.score({
      toolName: 'browser_click',
      args: {},
    });
    expect(nearThreshold.score).toBeLessThan(nearThreshold.threshold!);
    expect(nearThreshold.status).toBe('borderline');
    const rare = reranker.score({ toolName: 'skills_list', args: {} });
    expect(rare.score).toBe(rare.threshold);
    expect(rare.status).toBe('borderline');
  });

  test('still abstains before the minimum trajectory count', () => {
    const storeDir = makeTempDir();
    writeDiverseBaseline(storeDir);
    const reranker = new BehaviorAnomalyReranker({
      storeDir,
      agentId: AGENT_ID,
      minTrajectories: 51,
    });

    expect(reranker.score(UNSEEN_CALL)).toMatchObject({
      status: 'abstained',
      trajectoryCount: 50,
    });
  });

  test('recomputes the upper margin after the baseline grows', () => {
    const storeDir = makeTempDir();
    writeDiverseBaseline(storeDir);
    const reranker = new BehaviorAnomalyReranker({
      storeDir,
      agentId: AGENT_ID,
      cacheTtlMs: 0,
    });
    const initial = reranker.score(UNSEEN_CALL);
    expect(initial.status).toBe('scored');

    writeDiverseBaseline(storeDir, 7, true);
    const grown = reranker.score(UNSEEN_CALL);
    expect(grown.trajectoryCount).toBe(400);
    expect(grown.threshold).toBeGreaterThan(initial.threshold!);
    expect(grown.status).toBe('scored');
    expect(grown.score).toBeGreaterThan(grown.threshold!);
  });

  test.each([
    {
      call: {
        toolName: 'grep',
        args: { pattern: 'example', path: '/workspace/src' },
      },
      baseTier: 'green',
      tier: 'yellow',
      decision: 'implicit',
    },
    {
      call: UNSEEN_CALL,
      baseTier: 'yellow',
      tier: 'red',
      decision: 'required',
    },
  ])(
    'elevates an unfamiliar $baseTier action to $tier through the approval pipeline',
    ({ call, baseTier, tier, decision }) => {
      const dir = makeTempDir();
      writeDiverseBaseline(dir);
      vi.stubEnv('HYBRIDCLAW_BEHAVIOR_ANOMALY_TRAJECTORY_STORE_DIR', dir);
      vi.stubEnv('HYBRIDCLAW_AGENT_ID', AGENT_ID);
      const runtime = new TrustedAgentApprovalRuntime(
        path.join(dir, 'policy.yaml'),
        path.join(dir, 'agent-trust.json'),
        path.join(dir, 'all-trust.json'),
        path.join(dir, 'legacy-trust.json'),
        undefined,
        path.join(dir, 'pending.json'),
      );

      const evaluation = runtime.evaluateToolCall({
        toolName: call.toolName,
        argsJson: JSON.stringify(call.args),
        latestUserPrompt: 'Inspect the project and prepare an example output.',
      });

      expect(evaluation.anomaly?.status).toBe('scored');
      expect(evaluation.anomaly?.traceJudge).toBeUndefined();
      expect(evaluation).toMatchObject({ baseTier, tier, decision });
    },
  );
});
