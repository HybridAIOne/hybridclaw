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

const OPTIONS = {
  target: { type: 'string' },
  suite: { type: 'string' },
  summary: { type: 'string' },
  manifest: { type: 'string' },
  rounds: { type: 'string' },
  k: { type: 'string' },
  'fresh-seed': { type: 'boolean' },
  'dry-run': { type: 'boolean' },
  commit: { type: 'boolean' },
} as const;

type FlagName = keyof typeof OPTIONS;
type Flags = {
  [Name in FlagName]?: (typeof OPTIONS)[Name]['type'] extends 'string'
    ? string
    : boolean;
} & { help?: boolean };

const PATH_FLAGS = ['target', 'suite', 'summary', 'manifest'] as const;

// Each subcommand accepts only its own flags, so `init --commit` fails
// instead of being silently ignored.
function parseFlags(args: string[], allowed: readonly FlagName[]): Flags {
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      ...Object.fromEntries(allowed.map((name) => [name, OPTIONS[name]])),
      help: { type: 'boolean', short: 'h' },
    },
  });
  const flags = values as Flags;
  // `npm run eval` starts in the repo root; INIT_CWD is where the user ran
  // it. Any other launcher may pass on an unrelated INIT_CWD.
  const base =
    process.env.npm_lifecycle_event === 'eval' && process.env.INIT_CWD
      ? process.env.INIT_CWD
      : process.cwd();
  for (const flag of PATH_FLAGS) {
    const value = flags[flag]?.trim();
    if (value) flags[flag] = path.resolve(base, value);
  }
  return flags;
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
const loadRuns = () => import('./harness-evolution-runs.js');

interface Subcommand {
  args: string;
  flags: readonly FlagName[];
  run: (flags: Flags, usage: string) => Promise<void>;
}

const SUBCOMMANDS: Record<string, Subcommand> = {
  init: {
    args: '--target <dir>',
    flags: ['target'],
    run: async (flags, usage) => {
      requireFlag(flags.target, usage);
      const { initializeHarnessWorkspace } = await loadEvolution();
      initializeHarnessWorkspace(flags.target);
      console.log(
        `Initialized harness evolution workspace at ${flags.target}.`,
      );
    },
  },
  'validate-seed': {
    args: '--target <dir>',
    flags: ['target'],
    run: async (flags, usage) => {
      requireFlag(flags.target, usage);
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
  },
  run: {
    args: '--target <dir> --suite <suite.json> [--rounds N] [--k N] [--fresh-seed] [--dry-run] [--commit]',
    flags: [
      'target',
      'suite',
      'rounds',
      'k',
      'fresh-seed',
      'dry-run',
      'commit',
    ],
    run: async (flags, usage) => {
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
  },
  list: {
    args: '--target <dir>',
    flags: ['target'],
    run: async (flags, usage) => {
      requireFlag(flags.target, usage);
      const { listHarnessEvolutionRuns } = await loadRuns();
      const { targetRoot, runs, incompleteRunIds } = listHarnessEvolutionRuns(
        flags.target,
      );
      console.log(`Harness evolution runs in ${targetRoot}: ${runs.length}`);
      for (const run of runs) {
        console.log(
          `${run.runId}  ${run.suiteName}  rounds=${run.roundCount}  ${run.bestRound === null ? `no new best (prior pass@1=${run.bestPassAt1})` : `best pass@1=${run.bestPassAt1} (round ${run.bestRound})`}  cost=${run.totalCostUsd} USD  ${run.createdAt}`,
        );
        console.log(`  summary: ${run.summaryPath}`);
      }
      if (incompleteRunIds.length > 0) {
        console.log(
          `Incomplete runs (no summary; failed or interrupted): ${incompleteRunIds.join(', ')}`,
        );
      }
    },
  },
  status: {
    args: '--summary <runs/.../summary.json>',
    flags: ['summary'],
    run: async (flags, usage) => {
      requireFlag(flags.summary, usage);
      const { readHarnessEvolutionSummary } = await loadRuns();
      const { renderEvolutionChart } = await loadEvolution();
      console.log(
        renderEvolutionChart(readHarnessEvolutionSummary(flags.summary)),
      );
    },
  },
  manifest: {
    args: '--manifest <runs/.../round-N/f12-manifest.json>',
    flags: ['manifest'],
    run: async (flags, usage) => {
      requireFlag(flags.manifest, usage);
      const { readHarnessEvolutionManifest } = await loadRuns();
      console.log(
        JSON.stringify(readHarnessEvolutionManifest(flags.manifest), null, 2),
      );
    },
  },
  contract: {
    args: '',
    flags: [],
    run: async () => {
      const { EVOLVE_AGENT_SYSTEM_PROMPT, EVOLVE_AGENT_TOOLS } =
        await loadEvolution();
      console.log(
        JSON.stringify(
          {
            systemPrompt: EVOLVE_AGENT_SYSTEM_PROMPT,
            tools: EVOLVE_AGENT_TOOLS,
          },
          null,
          2,
        ),
      );
    },
  },
};

function subcommandUsage(name: string): string {
  return `harness-evolve ${name} ${SUBCOMMANDS[name].args}`.trim();
}

async function renderUsage(): Promise<string> {
  const { HARNESS_SURFACES } = await loadEvolution();
  const surfaces = HARNESS_SURFACES.map(
    (surface) =>
      `${surface.relativePath}${surface.kind === 'directory' ? '/' : ''}`,
  );
  return [
    'Usage: npm run eval -- harness-evolve <subcommand>',
    '',
    'Commands:',
    ...Object.keys(SUBCOMMANDS).map((name) => `  ${subcommandUsage(name)}`),
    '',
    'Notes:',
    `  - Target coworker workspaces expose ${surfaces.length} editable surfaces:`,
    `    ${surfaces.join(', ')}.`,
    '  - Relative paths resolve against the directory the command ran from.',
    '  - run calls the auxiliaryModels.eval_judge model, else the auxiliary fallback chain, then the default model.',
    '  - Add --help to a subcommand to print only its usage.',
    '  - Fresh evolution refuses non-minimal seeds; production coworkers can use run without --fresh-seed.',
    '  - Suites may tag tasks with risks.nistAiRmf, risks.nistGaiProfile, and risks.owaspLlmTop10,',
    '    then require coverage with riskCoverage.requireNistAiRmfCore,',
    '    requireNistGaiProfile, or requireOwaspLlmTop10.',
    '  - contract prints the evolve-agent system prompt and tool schema for host orchestration.',
    '  - Round artifacts and F12 manifests are written under target runs/.',
  ].join('\n');
}

export async function runHarnessEvolveCommand(args: string[]): Promise<void> {
  const [sub = '', ...rest] = args;
  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') {
    console.log(await renderUsage());
    return;
  }
  if (!Object.hasOwn(SUBCOMMANDS, sub)) {
    throw new Error(
      `Unknown harness-evolve subcommand: ${sub}. Use ${Object.keys(SUBCOMMANDS).join(', ')}.`,
    );
  }
  const flags = parseFlags(rest, SUBCOMMANDS[sub].flags);
  if (flags.help) {
    console.log(`Usage: npm run eval -- ${subcommandUsage(sub)}`);
    return;
  }
  await SUBCOMMANDS[sub].run(flags, subcommandUsage(sub));
}
