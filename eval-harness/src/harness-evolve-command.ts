/**
 * `npm run eval -- harness-evolve <subcommand>` — the only entry point to the
 * R10a harness-evolution loop. The loop is unshipped (AGENTS.md §3.4): no
 * core CLI command, gateway route, or console page reads its run artifacts;
 * `list`, `status`, and `manifest` here are how operators inspect them.
 *
 * Works on a target workspace on disk and never talks to a gateway; only
 * `run` without `--dry-run` reaches a model (the configured auxiliary model).
 */
import path from 'node:path';
import { parseArgs } from 'node:util';
import { parsePositiveInteger } from '../../src/utils/number-normalization.js';

const USAGE = `Usage: npm run eval -- harness-evolve <subcommand>

Commands:
  init --target <dir>
  validate-seed --target <dir>
  run --target <dir> --suite <suite.json> [--rounds N] [--k N] [--fresh-seed] [--dry-run] [--commit]
  list --target <dir>
  status --summary <runs/.../summary.json>
  manifest --manifest <runs/.../round-N/f12-manifest.json>
  contract

Notes:
  - Target coworker workspaces expose seven editable surfaces:
    system_prompt.md, tools.yaml, tools/, middleware/, sub_agents/, config/, long_term_memory/.
  - Fresh evolution refuses non-minimal seeds; production coworkers can use run without --fresh-seed.
  - Suites may tag tasks with risks.nistAiRmf, risks.nistGaiProfile, and risks.owaspLlmTop10,
    then require coverage with riskCoverage.requireNistAiRmfCore,
    requireNistGaiProfile, or requireOwaspLlmTop10.
  - contract prints the evolve-agent system prompt and tool schema for host orchestration.
  - Round artifacts and F12 manifests are written under target runs/.`;

type Flags = {
  target?: string;
  suite?: string;
  summary?: string;
  manifest?: string;
  rounds?: string;
  k?: string;
  'fresh-seed'?: boolean;
  'dry-run'?: boolean;
  commit?: boolean;
};

function parseFlags(args: string[]): Flags {
  return parseArgs({
    args,
    strict: true,
    options: {
      target: { type: 'string' },
      suite: { type: 'string' },
      summary: { type: 'string' },
      manifest: { type: 'string' },
      rounds: { type: 'string' },
      k: { type: 'string' },
      'fresh-seed': { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      commit: { type: 'boolean' },
    },
  }).values;
}

function requireFlag(
  value: string | undefined,
  usage: string,
): asserts value is string {
  if (!value?.trim()) throw new Error(`Usage: ${usage}`);
}

function positiveIntegerFlag(
  value: string | undefined,
  label: string,
): number | undefined {
  if (value === undefined) return undefined;
  const parsed = parsePositiveInteger(value);
  if (parsed === null) throw new Error(`${label} must be a positive integer.`);
  return parsed;
}

const loadEvolution = () => import('./harness-evolution.js');

const SUBCOMMANDS: Record<string, (flags: Flags) => Promise<void>> = {
  init: async (flags) => {
    requireFlag(flags.target, 'harness-evolve init --target <dir>');
    const { initializeHarnessWorkspace } = await loadEvolution();
    initializeHarnessWorkspace(flags.target);
    console.log(
      `Initialized harness evolution workspace at ${path.resolve(flags.target)}.`,
    );
  },
  'validate-seed': async (flags) => {
    requireFlag(flags.target, 'harness-evolve validate-seed --target <dir>');
    const { validateBashOnlySeed } = await loadEvolution();
    const validation = validateBashOnlySeed(flags.target);
    for (const warning of validation.warnings) {
      console.log(`warning: ${warning}`);
    }
    if (!validation.ok) {
      for (const error of validation.errors) console.error(`error: ${error}`);
      process.exitCode = 1;
      return;
    }
    console.log('Seed is a minimal bash-only harness.');
  },
  run: async (flags) => {
    const usage = 'harness-evolve run --target <dir> --suite <suite.json>';
    requireFlag(flags.target, usage);
    requireFlag(flags.suite, usage);
    const { renderEvolutionChart, runHarnessEvolutionLoop } =
      await loadEvolution();
    const result = await runHarnessEvolutionLoop({
      targetRoot: flags.target,
      suitePath: flags.suite,
      rounds: positiveIntegerFlag(flags.rounds, '--rounds'),
      rolloutsPerTask: positiveIntegerFlag(flags.k, '--k'),
      freshSeed: Boolean(flags['fresh-seed']),
      dryRun: Boolean(flags['dry-run']),
      commit: Boolean(flags.commit),
    });
    console.log(renderEvolutionChart(result));
    console.log(`Summary: ${result.summaryPath}`);
    if (!result.costGate.ok) process.exitCode = 1;
  },
  list: async (flags) => {
    requireFlag(flags.target, 'harness-evolve list --target <dir>');
    const { listHarnessEvolutionRuns } = await loadEvolution();
    const { targetRoot, runs } = listHarnessEvolutionRuns(flags.target);
    console.log(`Harness evolution runs in ${targetRoot}: ${runs.length}`);
    for (const run of runs) {
      console.log(
        `${run.runId}  ${run.suiteName}  rounds=${run.roundCount}  best pass@1=${run.bestPassAt1} (round ${run.bestRound ?? 'none'})  cost=${run.totalCostUsd} USD  ${run.createdAt}`,
      );
      console.log(`  summary: ${run.summaryPath}`);
    }
  },
  status: async (flags) => {
    requireFlag(
      flags.summary,
      'harness-evolve status --summary <runs/.../summary.json>',
    );
    const { readHarnessEvolutionSummary, renderEvolutionChart } =
      await loadEvolution();
    console.log(
      renderEvolutionChart(readHarnessEvolutionSummary(flags.summary)),
    );
  },
  manifest: async (flags) => {
    requireFlag(
      flags.manifest,
      'harness-evolve manifest --manifest <runs/.../f12-manifest.json>',
    );
    const { readHarnessEvolutionManifest } = await loadEvolution();
    console.log(
      JSON.stringify(readHarnessEvolutionManifest(flags.manifest), null, 2),
    );
  },
  contract: async () => {
    const { EVOLVE_AGENT_SYSTEM_PROMPT, EVOLVE_AGENT_TOOLS } =
      await loadEvolution();
    console.log(
      JSON.stringify(
        { systemPrompt: EVOLVE_AGENT_SYSTEM_PROMPT, tools: EVOLVE_AGENT_TOOLS },
        null,
        2,
      ),
    );
  },
};

export async function runHarnessEvolveCommand(args: string[]): Promise<void> {
  const [sub = '', ...rest] = args;
  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') {
    console.log(USAGE);
    return;
  }
  if (!Object.hasOwn(SUBCOMMANDS, sub)) {
    throw new Error(
      `Unknown harness-evolve subcommand: ${sub}. Use ${Object.keys(SUBCOMMANDS).join(', ')}.`,
    );
  }
  await SUBCOMMANDS[sub](parseFlags(rest));
}
