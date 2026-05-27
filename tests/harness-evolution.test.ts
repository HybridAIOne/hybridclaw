import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, test } from 'vitest';
import {
  calculateEvolutionMetrics,
  initializeHarnessWorkspace,
  listHarnessEvolutionRuns,
  renderEvolutionChart,
  resolveHarnessSurfacePath,
  runHarnessEvolutionLoop,
  validateBashOnlySeed,
  writeHarnessSurfaceFile,
} from '../src/evolution/harness-evolution.ts';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-evolve-'));
}

function writeSuite(dir: string): string {
  const suitePath = path.join(dir, 'suite.json');
  fs.writeFileSync(
    suitePath,
    `${JSON.stringify(
      {
        id: 'demo-suite',
        name: 'Demo suite',
        costBudgetUsd: 0.02,
        tasks: [{ id: 'task-a' }, { id: 'task-b' }],
      },
      null,
      2,
    )}\n`,
    'utf-8',
  );
  return suitePath;
}

describe('harness evolution', () => {
  test('initializes and validates a minimal bash-only target workspace', () => {
    const targetRoot = makeTempDir();

    initializeHarnessWorkspace(targetRoot);

    expect(validateBashOnlySeed(targetRoot)).toMatchObject({ ok: true });
    expect(fs.existsSync(path.join(targetRoot, 'system_prompt.md'))).toBe(true);
    expect(fs.existsSync(path.join(targetRoot, 'long_term_memory'))).toBe(true);
  });

  test('rejects pre-fitted fresh seeds', () => {
    const targetRoot = makeTempDir();
    initializeHarnessWorkspace(targetRoot);
    fs.writeFileSync(
      path.join(targetRoot, 'tools.yaml'),
      'tools:\n  - name: salesforce_query\n',
      'utf-8',
    );

    const validation = validateBashOnlySeed(targetRoot);

    expect(validation.ok).toBe(false);
    expect(validation.errors.join('\n')).toContain('tools.yaml');
  });

  test('reports malformed tools.yaml as seed validation error', () => {
    const targetRoot = makeTempDir();
    initializeHarnessWorkspace(targetRoot);
    fs.writeFileSync(path.join(targetRoot, 'tools.yaml'), 'tools: [', 'utf-8');

    const validation = validateBashOnlySeed(targetRoot);

    expect(validation.ok).toBe(false);
    expect(validation.errors.join('\n')).toContain('invalid YAML');
  });

  test('enforces the seven editable surfaces and read-only run paths', () => {
    const targetRoot = makeTempDir();
    initializeHarnessWorkspace(targetRoot);

    expect(resolveHarnessSurfacePath(targetRoot, 'tools/fix.js')).toMatchObject(
      {
        surface: 'tools',
      },
    );
    expect(() => resolveHarnessSurfacePath(targetRoot, '../escape.md')).toThrow(
      /traversal|escapes/,
    );
    expect(() =>
      resolveHarnessSurfacePath(targetRoot, 'runs/latest/output.json'),
    ).toThrow(/read-only/);
    expect(() => resolveHarnessSurfacePath(targetRoot, 'README.md')).toThrow(
      /seven editable surfaces/,
    );
  });

  test('rejects symlink escapes under editable surfaces', () => {
    const cwd = makeTempDir();
    const targetRoot = path.join(cwd, 'target');
    const outside = path.join(cwd, 'outside');
    initializeHarnessWorkspace(targetRoot);
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(targetRoot, 'tools', 'linked'));

    expect(() =>
      resolveHarnessSurfacePath(targetRoot, 'tools/linked/escape.js'),
    ).toThrow(/symlink/);
  });

  test('writes F12 manifest entries with falsifiable contracts', () => {
    const targetRoot = makeTempDir();
    initializeHarnessWorkspace(targetRoot);
    const manifestPath = path.join(targetRoot, 'runs', 'round-1', 'f12.json');

    const entry = writeHarnessSurfaceFile({
      targetRoot,
      manifestPath,
      round: 1,
      relativePath: 'long_term_memory/task-a.md',
      content: 'Remember task A requires checking stderr.\n',
      surface: 'long_term_memory',
      prediction: 'task-a first rollout succeeds',
      verifier: 'hybridclaw eval demo-suite run --task task-a',
      rollbackScope: 'long_term_memory/task-a.md',
      rationale: 'distilled trace showed repeated stderr misses',
    });

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as {
      entries: Array<Record<string, unknown>>;
    };
    expect(entry.beforeHash).toBeNull();
    expect(manifest.entries).toHaveLength(1);
    expect(manifest.entries[0]).not.toHaveProperty('beforeContent');
    expect(
      fs.readFileSync(path.join(targetRoot, entry.path), 'utf-8'),
    ).toContain('stderr');
  });

  test('calculates pass@1 and Succ/Mtok metrics', () => {
    const metrics = calculateEvolutionMetrics([
      { taskId: 'a', rollout: 1, success: true, tokens: 1000 },
      { taskId: 'a', rollout: 2, success: false, tokens: 1000 },
      { taskId: 'b', rollout: 1, success: false, tokens: 1000 },
      { taskId: 'b', rollout: 2, success: true, tokens: 1000 },
    ]);

    expect(metrics.passAt1).toBe(0.5);
    expect(metrics.successCount).toBe(2);
    expect(metrics.succPerMtok).toBe(500);
  });

  test('runs a dry evolution loop and renders admin chart lines', async () => {
    const cwd = makeTempDir();
    const targetRoot = path.join(cwd, 'agent-a');
    initializeHarnessWorkspace(targetRoot);
    const suitePath = writeSuite(cwd);

    const result = await runHarnessEvolutionLoop({
      targetRoot,
      suitePath,
      rounds: 2,
      rolloutsPerTask: 2,
      freshSeed: true,
      dryRun: true,
      outcomesByRound: [
        [
          { taskId: 'task-a', rollout: 1, success: false, tokens: 1000 },
          { taskId: 'task-a', rollout: 2, success: true, tokens: 1000 },
          { taskId: 'task-b', rollout: 1, success: false, tokens: 1000 },
          { taskId: 'task-b', rollout: 2, success: false, tokens: 1000 },
        ],
        [
          { taskId: 'task-a', rollout: 1, success: true, tokens: 1000 },
          { taskId: 'task-a', rollout: 2, success: true, tokens: 1000 },
          { taskId: 'task-b', rollout: 1, success: true, tokens: 1000 },
          { taskId: 'task-b', rollout: 2, success: true, tokens: 1000 },
        ],
      ],
    });

    expect(result.bestRound).toBe(2);
    expect(result.bestPassAt1).toBe(1);
    expect(fs.existsSync(result.summaryPath)).toBe(true);
    expect(listHarnessEvolutionRuns(targetRoot).runs[0]?.runId).toBe(
      result.runId,
    );
    expect(renderEvolutionChart(result)).toContain('Round | pass@1');
  });

  test('stops evolution rounds when the suite cost budget is exceeded', async () => {
    const cwd = makeTempDir();
    const targetRoot = path.join(cwd, 'agent-a');
    initializeHarnessWorkspace(targetRoot);
    const suitePath = writeSuite(cwd);

    const result = await runHarnessEvolutionLoop({
      targetRoot,
      suitePath,
      rounds: 3,
      freshSeed: true,
      dryRun: true,
      outcomesByRound: [
        [
          {
            taskId: 'task-a',
            rollout: 1,
            success: true,
            tokens: 1,
            costUsd: 1,
          },
        ],
        [
          {
            taskId: 'task-a',
            rollout: 1,
            success: true,
            tokens: 1,
            costUsd: 1,
          },
        ],
        [
          {
            taskId: 'task-a',
            rollout: 1,
            success: true,
            tokens: 1,
            costUsd: 1,
          },
        ],
      ],
    });

    expect(result.rounds).toHaveLength(1);
    expect(result.costGate.ok).toBe(false);
  });

  test('runs an evolve agent when the distilled report has no injected edits', async () => {
    const cwd = makeTempDir();
    const targetRoot = path.join(cwd, 'agent-a');
    initializeHarnessWorkspace(targetRoot);
    const suitePath = writeSuite(cwd);

    const result = await runHarnessEvolutionLoop({
      targetRoot,
      suitePath,
      runId: 'auto-evolve',
      rounds: 1,
      freshSeed: true,
      outcomesByRound: [
        [{ taskId: 'task-a', rollout: 1, success: false, tokens: 1 }],
      ],
      evolveAgent: async (request) => ({
        edits: [
          {
            surface: 'long_term_memory',
            relativePath: 'long_term_memory/task-a.md',
            content: `Round ${request.round}: remember stderr evidence.\n`,
            prediction: 'task-a pass@1 improves',
            verifier: 'hybridclaw eval demo-suite run --task task-a',
            rollbackScope: 'long_term_memory/task-a.md',
          },
        ],
        outputPath: path.join(request.roundDir, 'fake-evolve-output.md'),
        provider: 'test',
        model: 'test-model',
      }),
    });

    expect(result.rounds[0]?.evolveAgent).toMatchObject({
      source: 'evolve_agent',
      editCount: 1,
      provider: 'test',
      model: 'test-model',
    });
    expect(
      fs.readFileSync(
        path.join(targetRoot, 'long_term_memory', 'task-a.md'),
        'utf-8',
      ),
    ).toContain('stderr evidence');
  });

  test('reports seed delta for in-place production coworker evolution', async () => {
    const cwd = makeTempDir();
    const targetRoot = path.join(cwd, 'agent-a');
    initializeHarnessWorkspace(targetRoot);
    fs.writeFileSync(
      path.join(targetRoot, 'long_term_memory', 'existing.md'),
      'Production coworker memory.\n',
      'utf-8',
    );
    const suitePath = writeSuite(cwd);

    const result = await runHarnessEvolutionLoop({
      targetRoot,
      suitePath,
      runId: 'seed-delta',
      rounds: 1,
      dryRun: true,
      outcomesByRound: [
        [{ taskId: 'task-a', rollout: 1, success: true, tokens: 1 }],
      ],
    });

    expect(result.seedDelta).toMatchObject({
      mode: 'in_place',
      changedSurfaceCount: 1,
      changedSurfaces: ['long_term_memory'],
      fileCount: 1,
    });
    expect(renderEvolutionChart(result)).toContain('Seed delta: in-place 1/7');
  });

  test('orders evolved edits by component-ablation guidance before prompt edits', async () => {
    const cwd = makeTempDir();
    const targetRoot = path.join(cwd, 'agent-a');
    initializeHarnessWorkspace(targetRoot);
    const suitePath = writeSuite(cwd);

    const result = await runHarnessEvolutionLoop({
      targetRoot,
      suitePath,
      runId: 'ordered-edits',
      rounds: 1,
      outcomesByRound: [
        [{ taskId: 'task-a', rollout: 1, success: false, tokens: 1 }],
      ],
      editsByRound: [
        [
          {
            surface: 'system_prompt',
            relativePath: 'system_prompt.md',
            content: 'You are a bash-only agent. Remember task A evidence.\n',
            prediction: 'system prompt improves task-a',
            verifier: 'hybridclaw eval demo-suite run --task task-a',
            rollbackScope: 'system_prompt.md',
          },
          {
            surface: 'long_term_memory',
            relativePath: 'long_term_memory/task-a.md',
            content: 'Remember task A evidence first.\n',
            prediction: 'memory improves task-a',
            verifier: 'hybridclaw eval demo-suite run --task task-a',
            rollbackScope: 'long_term_memory/task-a.md',
          },
        ],
      ],
    });

    const manifest = JSON.parse(
      fs.readFileSync(result.rounds[0]?.manifestPath || '', 'utf-8'),
    ) as { entries: Array<{ surface: string }> };
    expect(manifest.entries.map((entry) => entry.surface)).toEqual([
      'long_term_memory',
      'system_prompt',
    ]);
  });

  test('rolls back disconfirmed previous-round manifest entries', async () => {
    const cwd = makeTempDir();
    const targetRoot = path.join(cwd, 'agent-a');
    initializeHarnessWorkspace(targetRoot);
    const suitePath = writeSuite(cwd);
    const relativePath = 'long_term_memory/task-a.md';
    const content = 'Remember task A requires checking stderr.\n';
    const entryId = `f12-1-${crypto.createHash('sha256').update(`${relativePath}\n${content}`).digest('hex').slice(0, 12)}`;

    await runHarnessEvolutionLoop({
      targetRoot,
      suitePath,
      runId: 'rollback-demo',
      rounds: 2,
      rolloutsPerTask: 1,
      freshSeed: true,
      outcomesByRound: [
        [{ taskId: 'task-a', rollout: 1, success: true, tokens: 1 }],
        [{ taskId: 'task-a', rollout: 1, success: true, tokens: 1 }],
      ],
      disconfirmedEntryIdsByRound: [[entryId]],
      editsByRound: [
        [
          {
            surface: 'long_term_memory',
            relativePath,
            content,
            prediction: 'task-a pass@1 improves',
            verifier: 'hybridclaw eval demo-suite run --task task-a',
            rollbackScope: relativePath,
          },
        ],
      ],
    });

    expect(fs.existsSync(path.join(targetRoot, relativePath))).toBe(false);
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(
          targetRoot,
          'runs',
          'rollback-demo',
          'round-1',
          'f12-manifest.json',
        ),
        'utf-8',
      ),
    ) as { entries: Array<{ confirmed?: boolean; rolledBackAt?: string }> };
    expect(manifest.entries[0]?.confirmed).toBe(false);
    expect(manifest.entries[0]?.rolledBackAt).toBeTruthy();
  });

  test('runs command-backed per-skill eval suites from evals/scenarios.json', async () => {
    const cwd = makeTempDir();
    const targetRoot = path.join(cwd, 'agent-a');
    const skillDir = path.join(cwd, 'skills', 'demo');
    initializeHarnessWorkspace(targetRoot);
    fs.mkdirSync(path.join(skillDir, 'evals'), { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'evals', 'scenarios.json'),
      `${JSON.stringify(
        {
          id: 'demo-skill',
          name: 'Demo Skill',
          tasks: [
            {
              id: 'ok',
              command: `${JSON.stringify(process.execPath)} -e "console.log('ok')"`,
            },
            {
              id: 'fail',
              command: `${JSON.stringify(process.execPath)} -e "process.exit(3)"`,
            },
          ],
        },
        null,
        2,
      )}\n`,
      'utf-8',
    );

    const result = await runHarnessEvolutionLoop({
      targetRoot,
      suitePath: skillDir,
      runId: 'command-suite',
      rounds: 1,
      rolloutsPerTask: 1,
      freshSeed: true,
      dryRun: true,
    });

    expect(result.suite.sourcePath).toBe(
      path.join(skillDir, 'evals', 'scenarios.json'),
    );
    expect(result.rounds[0]?.metrics.passAt1).toBe(0.5);
    expect(result.rounds[0]?.metrics.successCount).toBe(1);
  });

  test('rejects suites without concrete commands when no outcomes are provided', async () => {
    const cwd = makeTempDir();
    const targetRoot = path.join(cwd, 'agent-a');
    initializeHarnessWorkspace(targetRoot);
    const suitePath = writeSuite(cwd);

    await expect(
      runHarnessEvolutionLoop({
        targetRoot,
        suitePath,
        runId: 'missing-command',
        rounds: 1,
        freshSeed: true,
      }),
    ).rejects.toThrow(/missing command/);
  });

  test('rejects fixed reportPath across multiple rounds', async () => {
    const cwd = makeTempDir();
    const targetRoot = path.join(cwd, 'agent-a');
    initializeHarnessWorkspace(targetRoot);
    const suitePath = writeSuite(cwd);

    await expect(
      runHarnessEvolutionLoop({
        targetRoot,
        suitePath,
        runId: 'fixed-report',
        rounds: 2,
        freshSeed: true,
        reportPath: path.join(cwd, 'report.md'),
        outcomesByRound: [
          [{ taskId: 'task-a', rollout: 1, success: true, tokens: 1 }],
          [{ taskId: 'task-a', rollout: 1, success: true, tokens: 1 }],
        ],
      }),
    ).rejects.toThrow(/reportPath/);
  });
});
