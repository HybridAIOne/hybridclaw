/**
 * Run-artifact reader for the harness-evolution loop: lists, reads, and
 * indexes what a run left under a target's `runs/`, including runs written by
 * earlier releases. The loop (`harness-evolution.ts`) produces the artifacts;
 * this module writes only the `list-entry.json` index on its behalf and never
 * edits a surface or reaches a model.
 */
import fs from 'node:fs';
import path from 'node:path';
import type {
  EvolutionEvalSuite,
  EvolutionRunResult,
  EvolutionSeedDelta,
  F12HarnessManifest,
} from './harness-evolution.js';
import {
  calculateHarnessRiskCoverage,
  emptyRiskReferences,
  parseHarnessRiskCoverageRequirements,
} from './harness-risk-taxonomy.js';

export interface HarnessEvolutionRunListEntry {
  runId: string;
  targetRoot: string;
  suiteId: string;
  suiteName: string;
  roundCount: number;
  bestPassAt1: number;
  bestRound: number | null;
  totalCostUsd: number;
  seedDeltaMode: EvolutionSeedDelta['mode'];
  seedDeltaChangedSurfaceCount: number;
  summaryPath: string;
  createdAt: string;
}

export interface HarnessEvolutionRunList {
  targetRoot: string;
  runs: HarnessEvolutionRunListEntry[];
  /** Run directories with no summary: the run failed or was interrupted. */
  incompleteRunIds: string[];
}

export function listHarnessEvolutionRuns(
  targetRoot: string,
): HarnessEvolutionRunList {
  const root = path.resolve(targetRoot);
  const runsDir = path.join(root, 'runs');
  const runs: HarnessEvolutionRunListEntry[] = [];
  const incompleteRunIds: string[] = [];
  if (!fs.existsSync(runsDir)) {
    return { targetRoot: root, runs, incompleteRunIds };
  }
  for (const entry of fs.readdirSync(runsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const run = readRunListEntry(path.join(runsDir, entry.name));
    if (run) runs.push(run);
    else incompleteRunIds.push(entry.name);
  }
  runs.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  return { targetRoot: root, runs, incompleteRunIds: incompleteRunIds.sort() };
}

export function readHarnessEvolutionSummary(
  summaryPath: string,
): EvolutionRunResult {
  const absolutePath = path.resolve(summaryPath);
  const parsed = readJsonFile<EvolutionRunResult | undefined>(
    absolutePath,
    'harness evolution summary',
  );
  if (!parsed || typeof parsed !== 'object' || !parsed.runId) {
    throw new Error(`Invalid harness evolution summary: ${summaryPath}`);
  }
  return {
    ...parsed,
    suite: withRiskCoverage(parsed.suite),
    summaryPath: absolutePath,
  };
}

function withRiskCoverage(suite: EvolutionEvalSuite): EvolutionEvalSuite {
  const tasks = suite.tasks.map((task) => ({
    ...task,
    riskReferences: task.riskReferences || emptyRiskReferences(),
  }));
  const riskCoverageRequirements =
    suite.riskCoverageRequirements ||
    parseHarnessRiskCoverageRequirements(undefined);
  const riskCoverage =
    suite.riskCoverage ||
    calculateHarnessRiskCoverage(tasks, riskCoverageRequirements);
  return {
    ...suite,
    tasks,
    riskCoverageRequirements,
    riskCoverage,
  };
}

export function readHarnessEvolutionManifest(
  manifestPath: string,
): F12HarnessManifest {
  const absolutePath = path.resolve(manifestPath);
  const parsed = readJsonFile<F12HarnessManifest | undefined>(
    absolutePath,
    'F12 harness manifest',
  );
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.entries)) {
    throw new Error(`Invalid F12 harness manifest: ${manifestPath}`);
  }
  return parsed;
}

function readJsonFile<T>(filePath: string, label: string): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch (error) {
    throw new Error(
      `Invalid ${label} JSON at ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function readRunListEntry(runDir: string): HarnessEvolutionRunListEntry | null {
  const listEntryPath = path.join(runDir, 'list-entry.json');
  if (fs.existsSync(listEntryPath)) {
    return readJsonFile<HarnessEvolutionRunListEntry>(
      listEntryPath,
      'harness evolution run list entry',
    );
  }
  const summaryPath = path.join(runDir, 'summary.json');
  if (!fs.existsSync(summaryPath)) return null;
  const summary = readHarnessEvolutionSummary(summaryPath);
  const stat = fs.statSync(summary.summaryPath);
  return makeRunListEntry(summary, stat.birthtime.toISOString());
}

function makeRunListEntry(
  result: EvolutionRunResult,
  createdAt = new Date().toISOString(),
): HarnessEvolutionRunListEntry {
  return {
    runId: result.runId,
    targetRoot: result.targetRoot,
    suiteId: result.suite.id,
    suiteName: result.suite.name,
    roundCount: result.rounds.length,
    bestPassAt1: result.bestPassAt1,
    bestRound: result.bestRound,
    totalCostUsd: result.costGate.totalCostUsd,
    seedDeltaMode: result.seedDelta.mode,
    seedDeltaChangedSurfaceCount: result.seedDelta.changedSurfaceCount,
    summaryPath: result.summaryPath,
    createdAt,
  };
}

export function writeRunListEntry(
  runDir: string,
  result: EvolutionRunResult,
): void {
  fs.writeFileSync(
    path.join(runDir, 'list-entry.json'),
    `${JSON.stringify(makeRunListEntry(result), null, 2)}\n`,
    'utf-8',
  );
}
