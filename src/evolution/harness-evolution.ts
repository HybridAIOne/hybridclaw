import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { redactSecrets } from '../security/redact.js';
import {
  type AgentRiskReferences,
  assertHarnessRiskCoverage,
  calculateHarnessRiskCoverage,
  emptyRiskReferences,
  type HarnessRiskCoverage,
  type HarnessRiskCoverageRequirements,
  parseAgentRiskReferences,
  parseHarnessRiskCoverageRequirements,
} from './harness-risk-taxonomy.js';

export const HARNESS_EVOLUTION_SCHEMA_VERSION = 1;
export const DEFAULT_EVOLUTION_ROUNDS = 10;
export const DEFAULT_ROLLOUTS_PER_TASK = 3;
export const DEFAULT_SKILLOPT_MAX_EDITS_PER_ROUND = 4;
const DEFAULT_SYSTEM_PROMPT =
  'You are a bash-only agent. Use shell commands to solve eval tasks.\n';
const DEFAULT_TOOLS_YAML = 'tools: []\n';

export type HarnessSurface =
  | 'system_prompt'
  | 'tools_yaml'
  | 'tools'
  | 'middleware'
  | 'sub_agents'
  | 'config'
  | 'long_term_memory';

export interface HarnessSurfaceDefinition {
  surface: HarnessSurface;
  relativePath: string;
  kind: 'file' | 'directory';
}

export const HARNESS_SURFACES: HarnessSurfaceDefinition[] = [
  {
    surface: 'system_prompt',
    relativePath: 'system_prompt.md',
    kind: 'file',
  },
  {
    surface: 'tools_yaml',
    relativePath: 'tools.yaml',
    kind: 'file',
  },
  {
    surface: 'tools',
    relativePath: 'tools',
    kind: 'directory',
  },
  {
    surface: 'middleware',
    relativePath: 'middleware',
    kind: 'directory',
  },
  {
    surface: 'sub_agents',
    relativePath: 'sub_agents',
    kind: 'directory',
  },
  {
    surface: 'config',
    relativePath: 'config',
    kind: 'directory',
  },
  {
    surface: 'long_term_memory',
    relativePath: 'long_term_memory',
    kind: 'directory',
  },
];

const DIRECTORY_SURFACES = HARNESS_SURFACES.filter(
  (surface) => surface.kind === 'directory',
);
const FILE_SURFACES = HARNESS_SURFACES.filter(
  (surface) => surface.kind === 'file',
);
const IGNORED_EMPTY_MARKERS = new Set(['.gitkeep', '.keep']);
const READ_ONLY_TOP_LEVELS = new Set(['runs', 'verifier', 'model_config']);
const TRACE_TEXT_LIMIT = 20_000;
const METRIC_NUMBER_FORMATTER = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 3,
});
const EVOLVE_SURFACE_ORDER: Record<HarnessSurface, number> = {
  long_term_memory: 0,
  tools_yaml: 1,
  tools: 1,
  middleware: 2,
  sub_agents: 3,
  config: 3,
  system_prompt: 4,
};

export interface EvolveAgentToolContract {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const EVOLVE_AGENT_SYSTEM_PROMPT = `You are the HybridClaw harness-evolution agent.

Improve one target coworker harness at a time. Read the F11.4 debugger report,
then edit only these F12-governed surfaces: system_prompt.md, tools.yaml,
tools/, middleware/, sub_agents/, config/, and long_term_memory/.

Every edit must include a falsifiable prediction, verifier command or evidence
source, rollback scope, and affected surface. Co-evolve long-term memory, tools,
and middleware before changing the system prompt. Do not edit runs/, verifier/,
model_config/, eval outputs, secrets, or production traffic state.`;

export const EVOLVE_AGENT_TOOLS: EvolveAgentToolContract[] = [
  {
    name: 'read_f114_debugger_report',
    description:
      'Read a distilled F11.4 Agent Debugger report for the current evolution round.',
    inputSchema: {
      type: 'object',
      required: ['path'],
      additionalProperties: false,
      properties: {
        path: {
          type: 'string',
          description: 'Absolute or target-workspace-relative report path.',
        },
      },
    },
  },
  {
    name: 'write_f12_harness_surface',
    description:
      'Write one file under an allowed harness surface and append a falsifiable F12 manifest entry.',
    inputSchema: {
      type: 'object',
      required: [
        'path',
        'content',
        'surface',
        'prediction',
        'verifier',
        'rollbackScope',
      ],
      additionalProperties: false,
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
        surface: {
          type: 'string',
          enum: HARNESS_SURFACES.map((surface) => surface.surface),
        },
        prediction: { type: 'string' },
        verifier: { type: 'string' },
        rollbackScope: { type: 'string' },
        rationale: { type: 'string' },
      },
    },
  },
];

export interface HarnessWorkspaceValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export interface EvolutionEvalTask {
  id: string;
  skill?: string;
  expected?: string;
  command?: string;
  timeoutMs?: number;
  riskReferences: AgentRiskReferences;
  split?: 'train' | 'selection' | 'test';
}

export interface EvolutionEvalSuite {
  id: string;
  name: string;
  sourcePath: string;
  tasks: EvolutionEvalTask[];
  costBudgetUsd?: number;
  maxTokens?: number;
  riskCoverageRequirements: HarnessRiskCoverageRequirements;
  riskCoverage: HarnessRiskCoverage;
}

export interface EvolutionTaskOutcome {
  taskId: string;
  rollout: number;
  success: boolean;
  tokens: number;
  costUsd?: number;
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  durationMs?: number;
}

export interface EvolutionMetrics {
  taskCount: number;
  rolloutCount: number;
  successCount: number;
  passAt1: number;
  succPerMtok: number;
  totalTokens: number;
  totalCostUsd: number;
}

export interface EvolutionCostGate {
  ok: boolean;
  totalCostUsd: number;
  budgetUsd: number | null;
  reason: string | null;
}

export interface EvolutionSeedDelta {
  mode: 'fresh_seed' | 'in_place';
  changedSurfaceCount: number;
  changedSurfaces: HarnessSurface[];
  fileCount: number;
  notes: string[];
}

export interface SkillOptSelectionGate {
  mode: 'held_out_suite' | 'task_split' | 'shared_suite' | 'dry_run';
  accepted: boolean;
  reason: string;
  previousBestPassAt1: number;
  candidatePassAt1: number;
  trainTaskCount: number;
  selectionTaskCount: number;
  rejectedEditCount: number;
  selectionMetrics: EvolutionMetrics;
}

export interface SkillOptRoundStages {
  rollout: {
    status: 'completed';
    artifactPath: string;
    cleanedArtifactPath: string;
    taskCount: number;
    rolloutCount: number;
  };
  reflect: {
    status: 'completed';
    artifactPath: string;
    failureCount: number;
  };
  aggregateSelect: {
    status: 'completed';
    proposedEditCount: number;
    selectedEditCount: number;
    maxEdits: number;
  };
  update: {
    status: 'applied' | 'skipped';
    manifestPath: string;
    appliedEditCount: number;
  };
  gate: {
    status: 'accepted' | 'rejected' | 'dry_run' | 'skipped';
    artifactPath: string | null;
    cleanedArtifactPath: string | null;
    previousBestPassAt1: number;
    candidatePassAt1: number;
  };
  memory: {
    status: 'updated';
    optimizerMemoryPath: string;
    rejectedEditCount: number;
  };
}

export interface F12HarnessManifestEntry {
  id: string;
  round: number;
  surface: HarnessSurface;
  path: string;
  prediction: string;
  verifier: string;
  rollbackScope: string;
  rationale: string | null;
  beforeHash: string | null;
  afterHash: string;
  createdAt: string;
  confirmed?: boolean;
  rolledBackAt?: string;
}

export interface F12HarnessManifest {
  schemaVersion: number;
  targetRoot: string;
  entries: F12HarnessManifestEntry[];
}

export interface EvolutionRoundResult {
  round: number;
  metrics: EvolutionMetrics;
  selectionGate: SkillOptSelectionGate;
  attributionScore: number;
  editsPerSurface: Record<HarnessSurface, number>;
  manifestPath: string;
  reportPath: string;
  evolveAgent: EvolutionRoundAgentResult;
  improvedBest: boolean;
  gitCommit: string | null;
  stages: SkillOptRoundStages;
}

export interface EvolutionRunResult {
  runId: string;
  targetRoot: string;
  suite: EvolutionEvalSuite;
  rounds: EvolutionRoundResult[];
  bestPassAt1: number;
  bestRound: number | null;
  costGate: EvolutionCostGate;
  seedDelta: EvolutionSeedDelta;
  summaryPath: string;
  bestHarnessPath: string;
  rejectedEditsPath: string;
  optimizerMemoryPath: string;
}

export interface F12HarnessEdit {
  surface: HarnessSurface;
  relativePath: string;
  content: string;
  prediction: string;
  verifier: string;
  rollbackScope: string;
  rationale?: string;
}

export interface EvolutionRoundAgentResult {
  source: 'evolve_agent' | 'report_json' | 'provided_edits' | 'dry_run_skipped';
  editCount: number;
  outputPath: string | null;
  provider: string | null;
  model: string | null;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    costUsd?: number;
  };
}

export interface EvolveAgentRunRequest {
  targetRoot: string;
  round: number;
  roundDir: string;
  reportPath: string;
  report: string;
  suite: EvolutionEvalSuite;
  outcomes: EvolutionTaskOutcome[];
  seedDelta: EvolutionSeedDelta;
  maxEditsPerRound: number;
  rejectedEdits: SkillOptRejectedEdit[];
  optimizerMemory: string;
}

export interface EvolveAgentRunResult {
  edits: F12HarnessEdit[];
  outputPath: string | null;
  provider: string | null;
  model: string | null;
  usage?: EvolutionRoundAgentResult['usage'];
}

export type EvolveAgentRunner = (
  request: EvolveAgentRunRequest,
) => Promise<EvolveAgentRunResult>;

export interface HarnessEvolutionLoopOptions {
  targetRoot: string;
  suitePath: string;
  rounds?: number;
  rolloutsPerTask?: number;
  maxEditsPerRound?: number;
  freshSeed?: boolean;
  dryRun?: boolean;
  commit?: boolean;
  runId?: string;
  selectionSuitePath?: string;
  reportPath?: string;
  outcomesByRound?: EvolutionTaskOutcome[][];
  selectionOutcomesByRound?: EvolutionTaskOutcome[][];
  disconfirmedEntryIdsByRound?: string[][];
  editsByRound?: F12HarnessEdit[][];
  evolveAgent?: EvolveAgentRunner;
}

export interface SkillOptRejectedEdit {
  round: number;
  path: string;
  surface: HarnessSurface;
  prediction: string;
  verifier: string;
  reason: string;
  rejectedAt: string;
}

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

export interface HarnessEvolutionAdminState {
  targetRoot: string;
  runs: HarnessEvolutionRunListEntry[];
}

export interface HarnessEvolutionStarterSuites {
  trainSuitePath: string;
  selectionSuitePath: string;
  verifierPath: string;
}

export interface HarnessEvolutionSuiteBuilderTask {
  id: string;
  command: string;
  split: 'train' | 'selection';
  timeoutMs?: number;
}

export interface HarnessEvolutionSuiteBuilderInput {
  suiteId?: string;
  suiteName?: string;
  costBudgetUsd?: number;
  tasks: HarnessEvolutionSuiteBuilderTask[];
}

export function initializeHarnessWorkspace(targetRoot: string): void {
  fs.mkdirSync(targetRoot, { recursive: true });
  for (const surface of FILE_SURFACES) {
    const filePath = path.join(targetRoot, surface.relativePath);
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(
        filePath,
        surface.surface === 'system_prompt'
          ? DEFAULT_SYSTEM_PROMPT
          : DEFAULT_TOOLS_YAML,
        'utf-8',
      );
    }
  }
  for (const surface of DIRECTORY_SURFACES) {
    const dirPath = path.join(targetRoot, surface.relativePath);
    fs.mkdirSync(dirPath, { recursive: true });
    const keepPath = path.join(dirPath, '.gitkeep');
    if (!fs.existsSync(keepPath)) {
      fs.writeFileSync(keepPath, '', 'utf-8');
    }
  }
  if (!fs.existsSync(path.join(targetRoot, '.git'))) {
    spawnSync('git', ['init'], {
      cwd: targetRoot,
      stdio: 'ignore',
    });
  }
}

function shellQuoteArg(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

export function writeHarnessEvolutionStarterSuites(
  targetRoot: string,
): HarnessEvolutionStarterSuites {
  const root = path.resolve(targetRoot);
  fs.mkdirSync(path.join(root, 'evals'), { recursive: true });
  fs.mkdirSync(path.join(root, 'verifier'), { recursive: true });
  const verifierPath = path.join(root, 'verifier', 'check-starter-memory.mjs');
  const trainSuitePath = path.join(root, 'evals', 'train-suite.json');
  const selectionSuitePath = path.join(root, 'evals', 'selection-suite.json');
  if (!fs.existsSync(verifierPath)) {
    fs.writeFileSync(
      verifierPath,
      `import fs from 'node:fs';
import path from 'node:path';

const targetRoot = process.argv[2];
const memoryPath = path.join(targetRoot, 'long_term_memory', 'starter-debugging.md');
const text = fs.existsSync(memoryPath) ? fs.readFileSync(memoryPath, 'utf-8') : '';

if (!/stderr/i.test(text)) {
  console.error('expected long_term_memory/starter-debugging.md to mention stderr');
  process.exit(1);
}
`,
      'utf-8',
    );
  }
  const command = `${shellQuoteArg(process.execPath)} ${shellQuoteArg(verifierPath)} ${shellQuoteArg(root)}`;
  if (!fs.existsSync(trainSuitePath)) {
    fs.writeFileSync(
      trainSuitePath,
      `${JSON.stringify(
        {
          id: 'starter-stderr-train',
          name: 'Starter stderr memory train',
          costBudgetUsd: 0.05,
          tasks: [
            {
              id: 'remember-stderr-train',
              command,
              timeoutMs: 30_000,
            },
          ],
        },
        null,
        2,
      )}\n`,
      'utf-8',
    );
  }
  if (!fs.existsSync(selectionSuitePath)) {
    fs.writeFileSync(
      selectionSuitePath,
      `${JSON.stringify(
        {
          id: 'starter-stderr-selection',
          name: 'Starter stderr memory selection',
          costBudgetUsd: 0.05,
          tasks: [
            {
              id: 'remember-stderr-selection',
              command,
              timeoutMs: 30_000,
            },
          ],
        },
        null,
        2,
      )}\n`,
      'utf-8',
    );
  }
  return { trainSuitePath, selectionSuitePath, verifierPath };
}

export function writeHarnessEvolutionSpreadsheetBenchExample(
  targetRoot: string,
): HarnessEvolutionStarterSuites {
  const root = path.resolve(targetRoot);
  const exampleDir = path.join(root, 'evals', 'spreadsheetbench-style');
  fs.mkdirSync(exampleDir, { recursive: true });
  fs.mkdirSync(path.join(root, 'verifier'), { recursive: true });

  const trainFixturePath = path.join(exampleDir, 'train-orders.csv');
  const selectionFixturePath = path.join(exampleDir, 'selection-orders.csv');
  const verifierPath = path.join(
    root,
    'verifier',
    'check-spreadsheetbench-formula.mjs',
  );
  const trainSuitePath = path.join(
    root,
    'evals',
    'spreadsheetbench-formula-train.json',
  );
  const selectionSuitePath = path.join(
    root,
    'evals',
    'spreadsheetbench-formula-selection.json',
  );

  writeFileIfMissing(
    trainFixturePath,
    `${[
      'order_id,quantity,unit_price,discount_pct,tax_rate,final_total',
      'A-1001,4,19.5,0.10,0.07,',
      'A-1002,2,250,0.05,0.07,',
      'A-1003,11,7.25,0,0.07,',
    ].join('\n')}\n`,
  );
  writeFileIfMissing(
    selectionFixturePath,
    `${[
      'order_id,quantity,unit_price,discount_pct,tax_rate,final_total',
      'B-4401,9,12.75,0.15,0.0825,',
      'B-4402,1,999.99,0.20,0.0825,',
      'B-4403,17,3.4,0.05,0.0825,',
      'B-4404,5,120,0,0.0825,',
    ].join('\n')}\n`,
  );
  writeFileIfMissing(
    verifierPath,
    `import fs from 'node:fs';
import path from 'node:path';

const targetRoot = process.argv[2];
const split = process.argv[3] || 'train';
const fixturePath = path.join(
  targetRoot,
  'evals',
  'spreadsheetbench-style',
  split === 'selection' ? 'selection-orders.csv' : 'train-orders.csv',
);
const memoryPath = path.join(
  targetRoot,
  'long_term_memory',
  'spreadsheet-formula-repair.md',
);
const memory = fs.existsSync(memoryPath)
  ? fs.readFileSync(memoryPath, 'utf-8')
  : '';

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!fs.existsSync(fixturePath)) {
  fail('SpreadsheetBench-style fixture is missing: ' + fixturePath);
}

const [headerLine, ...rows] = fs
  .readFileSync(fixturePath, 'utf-8')
  .trim()
  .split(/\\r?\\n/u);
const headers = headerLine.split(',');
for (const column of [
  'quantity',
  'unit_price',
  'discount_pct',
  'tax_rate',
  'final_total',
]) {
  if (!headers.includes(column)) {
    fail('SpreadsheetBench-style fixture is missing column: ' + column);
  }
}

const requiredPatterns = [
  [/formula/i, 'write formulas, not pasted answers'],
  [/header/i, 'derive formulas from column headers'],
  [/constant|hard.?cod/i, 'avoid hard-coded constants'],
  [/hidden|held.?out|changed rows|selection/i, 'verify on held-out rows'],
  [/recalculate|recalc|verify/i, 'verify recalculation after edits'],
];
const missing = requiredPatterns
  .filter(([pattern]) => !pattern.test(memory))
  .map(([, label]) => label);

if (missing.length > 0) {
  fail(
    [
      'SpreadsheetBench-style formula task failed.',
      'Add long_term_memory/spreadsheet-formula-repair.md with reusable spreadsheet procedure notes.',
      'Missing: ' + missing.join('; '),
      'Rows in this split: ' + rows.length,
    ].join('\\n'),
  );
}

if (/A-1001|A-1002|A-1003/u.test(memory)) {
  fail('Spreadsheet memory appears overfit to train order IDs.');
}

console.log(
  'SpreadsheetBench-style formula procedure present for ' +
    split +
    ' split with ' +
    rows.length +
    ' rows.',
);
`,
  );

  const command = `${shellQuoteArg(process.execPath)} ${shellQuoteArg(verifierPath)} {targetRoot}`;
  fs.writeFileSync(
    trainSuitePath,
    `${JSON.stringify(
      {
        id: 'spreadsheetbench-formula-train',
        name: 'SpreadsheetBench-style formula train',
        costBudgetUsd: 0.05,
        tasks: [
          {
            id: 'spreadsheet-formula-train',
            command: `${command} train`,
            timeoutMs: 30_000,
          },
        ],
      },
      null,
      2,
    )}\n`,
    'utf-8',
  );
  fs.writeFileSync(
    selectionSuitePath,
    `${JSON.stringify(
      {
        id: 'spreadsheetbench-formula-selection',
        name: 'SpreadsheetBench-style formula selection',
        costBudgetUsd: 0.05,
        tasks: [
          {
            id: 'spreadsheet-formula-selection',
            command: `${command} selection`,
            timeoutMs: 30_000,
          },
        ],
      },
      null,
      2,
    )}\n`,
    'utf-8',
  );

  return { trainSuitePath, selectionSuitePath, verifierPath };
}

function writeFileIfMissing(filePath: string, content: string): void {
  if (fs.existsSync(filePath)) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
}

export function parseHarnessEvolutionSuiteBuilderInput(
  value: unknown,
): HarnessEvolutionSuiteBuilderInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Suite builder payload must be a JSON object.');
  }
  const record = value as Record<string, unknown>;
  const tasksValue = record.tasks;
  if (!Array.isArray(tasksValue)) {
    throw new Error('Suite builder payload must include a tasks array.');
  }
  return {
    suiteId: readString(record.suiteId),
    suiteName: readString(record.suiteName),
    costBudgetUsd: readNumber(record.costBudgetUsd),
    tasks: tasksValue.map(parseSuiteBuilderTask),
  };
}

function parseSuiteBuilderTask(
  value: unknown,
  index: number,
): HarnessEvolutionSuiteBuilderTask {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Suite builder task ${index + 1} must be a JSON object.`);
  }
  const record = value as Record<string, unknown>;
  const id = readString(record.id);
  const command = readString(record.command);
  const split = readString(record.split);
  if (!id) throw new Error(`Suite builder task ${index + 1} is missing id.`);
  if (!command) {
    throw new Error(`Suite builder task ${index + 1} is missing command.`);
  }
  if (split !== 'train' && split !== 'selection') {
    throw new Error(
      `Suite builder task ${index + 1} split must be train or selection.`,
    );
  }
  return {
    id,
    command,
    split,
    timeoutMs: readNumber(record.timeoutMs),
  };
}

export function writeHarnessEvolutionSuiteBuilder(
  targetRoot: string,
  input: HarnessEvolutionSuiteBuilderInput,
): HarnessEvolutionStarterSuites {
  const root = path.resolve(targetRoot);
  const suiteId = normalizeId(input.suiteId || input.suiteName || 'custom');
  const safeSuiteId = suiteId || 'custom';
  const suiteName = input.suiteName?.trim() || 'Custom harness eval';
  const trainTasks = input.tasks
    .filter((task) => task.split === 'train')
    .map(materializeSuiteBuilderTask);
  const selectionTasks = input.tasks
    .filter((task) => task.split === 'selection')
    .map(materializeSuiteBuilderTask);
  if (trainTasks.length === 0) {
    throw new Error('Add at least one train task command.');
  }
  if (selectionTasks.length === 0) {
    throw new Error('Add at least one selection task command.');
  }

  fs.mkdirSync(path.join(root, 'evals'), { recursive: true });
  const trainSuitePath = path.join(root, 'evals', `${safeSuiteId}-train.json`);
  const selectionSuitePath = path.join(
    root,
    'evals',
    `${safeSuiteId}-selection.json`,
  );
  const costBudgetUsd = input.costBudgetUsd;
  fs.writeFileSync(
    trainSuitePath,
    `${JSON.stringify(
      {
        id: `${safeSuiteId}-train`,
        name: `${suiteName} train`,
        ...(costBudgetUsd === undefined ? {} : { costBudgetUsd }),
        tasks: trainTasks,
      },
      null,
      2,
    )}\n`,
    'utf-8',
  );
  fs.writeFileSync(
    selectionSuitePath,
    `${JSON.stringify(
      {
        id: `${safeSuiteId}-selection`,
        name: `${suiteName} selection`,
        ...(costBudgetUsd === undefined ? {} : { costBudgetUsd }),
        tasks: selectionTasks,
      },
      null,
      2,
    )}\n`,
    'utf-8',
  );
  return {
    trainSuitePath,
    selectionSuitePath,
    verifierPath: '',
  };
}

function materializeSuiteBuilderTask(
  task: HarnessEvolutionSuiteBuilderTask,
): Record<string, unknown> {
  const id = normalizeId(task.id) || 'task';
  return {
    id,
    command: task.command.trim(),
    ...(task.timeoutMs === undefined ? {} : { timeoutMs: task.timeoutMs }),
  };
}

export function validateHarnessWorkspace(
  targetRoot: string,
): HarnessWorkspaceValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!fs.existsSync(targetRoot)) {
    return {
      ok: false,
      errors: [`Target workspace does not exist: ${targetRoot}`],
      warnings,
    };
  }
  for (const surface of HARNESS_SURFACES) {
    const surfacePath = path.join(targetRoot, surface.relativePath);
    if (!fs.existsSync(surfacePath)) {
      errors.push(`Missing ${surface.kind} surface: ${surface.relativePath}`);
      continue;
    }
    const stat = fs.statSync(surfacePath);
    if (surface.kind === 'file' && !stat.isFile()) {
      errors.push(`Expected file surface: ${surface.relativePath}`);
    }
    if (surface.kind === 'directory' && !stat.isDirectory()) {
      errors.push(`Expected directory surface: ${surface.relativePath}`);
    }
  }
  for (const entry of fs.readdirSync(targetRoot)) {
    if (READ_ONLY_TOP_LEVELS.has(entry)) {
      warnings.push(`Read-only top-level path is present: ${entry}`);
    }
  }
  return {
    ok: errors.length === 0,
    errors,
    warnings,
  };
}

export function validateBashOnlySeed(
  targetRoot: string,
): HarnessWorkspaceValidation {
  const layout = validateHarnessWorkspace(targetRoot);
  const errors = [...layout.errors];
  const warnings = [...layout.warnings];
  if (errors.length > 0) {
    return { ok: false, errors, warnings };
  }

  const systemPrompt = fs
    .readFileSync(path.join(targetRoot, 'system_prompt.md'), 'utf-8')
    .trim();
  if (!/\b(bash|shell|terminal)\b/i.test(systemPrompt)) {
    errors.push('system_prompt.md must be a bash-only seed prompt.');
  }
  if (
    /\b(browser|salesforce|hubspot|gmail|slack|discord|database)\b/i.test(
      systemPrompt,
    )
  ) {
    errors.push(
      'system_prompt.md appears pre-fitted to a product/domain instead of a minimal bash-only seed.',
    );
  }

  const toolsYamlPath = path.join(targetRoot, 'tools.yaml');
  const rawToolsYaml = fs.readFileSync(toolsYamlPath, 'utf-8').trim();
  if (rawToolsYaml) {
    let parsed: unknown;
    try {
      parsed = YAML.parse(rawToolsYaml) as unknown;
    } catch (error) {
      errors.push(
        `tools.yaml is invalid YAML: ${error instanceof Error ? error.message : String(error)}`,
      );
      parsed = null;
    }
    const tools = extractToolsArray(parsed);
    if (tools === null || tools.length > 0) {
      errors.push('tools.yaml must be empty or declare `tools: []`.');
    }
  }

  for (const surface of DIRECTORY_SURFACES) {
    const entries = fs
      .readdirSync(path.join(targetRoot, surface.relativePath))
      .filter((entry) => !IGNORED_EMPTY_MARKERS.has(entry));
    if (entries.length > 0) {
      errors.push(
        `${surface.relativePath}/ must be empty for a fresh bash-only seed.`,
      );
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
  };
}

function extractToolsArray(parsed: unknown): unknown[] | null {
  if (Array.isArray(parsed)) return parsed;
  if (!parsed || typeof parsed !== 'object') return null;
  const tools = (parsed as { tools?: unknown }).tools;
  return Array.isArray(tools) ? tools : null;
}

export function resolveHarnessSurfacePath(
  targetRoot: string,
  relativePath: string,
): { absolutePath: string; surface: HarnessSurface } {
  const normalizedRelative = normalizeRelativePath(relativePath);
  const absolutePath = path.resolve(targetRoot, normalizedRelative);
  const root = path.resolve(targetRoot);
  if (absolutePath !== root && !absolutePath.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Harness edit escapes target workspace: ${relativePath}`);
  }
  assertNoSymlinkEscape(root, normalizedRelative, absolutePath);
  const topLevel = normalizedRelative.split(/[\\/]/)[0] || '';
  if (READ_ONLY_TOP_LEVELS.has(topLevel)) {
    throw new Error(`Harness edit targets read-only path: ${relativePath}`);
  }
  const surface = HARNESS_SURFACES.find((definition) => {
    if (definition.kind === 'file') {
      return normalizedRelative === definition.relativePath;
    }
    return (
      normalizedRelative === definition.relativePath ||
      normalizedRelative.startsWith(`${definition.relativePath}/`)
    );
  });
  if (!surface) {
    throw new Error(
      `Harness edit must target one of the seven editable surfaces: ${relativePath}`,
    );
  }
  return { absolutePath, surface: surface.surface };
}

export function loadEvolutionEvalSuite(suitePath: string): EvolutionEvalSuite {
  const absolutePath = resolveSuitePath(suitePath);
  const raw = fs.readFileSync(absolutePath, 'utf-8');
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Eval suite must be a JSON object: ${suitePath}`);
  }
  const record = parsed as Record<string, unknown>;
  const rawTasks = Array.isArray(record.tasks)
    ? record.tasks
    : Array.isArray(record.scenarios)
      ? record.scenarios
      : null;
  if (!rawTasks || rawTasks.length === 0) {
    throw new Error(
      'Eval suite must declare a non-empty tasks or scenarios array.',
    );
  }
  const tasks = rawTasks.map((task, index) => parseEvalTask(task, index));
  const riskCoverageRequirements = parseHarnessRiskCoverageRequirements(
    record.riskCoverage,
  );
  const riskCoverage = calculateHarnessRiskCoverage(
    tasks,
    riskCoverageRequirements,
  );
  assertHarnessRiskCoverage(riskCoverage);

  return {
    id: normalizeId(readString(record.id) || path.basename(absolutePath)),
    name: readString(record.name) || path.basename(absolutePath),
    sourcePath: absolutePath,
    tasks,
    costBudgetUsd: readNumber(record.costBudgetUsd),
    maxTokens: readNumber(record.maxTokens),
    riskCoverageRequirements,
    riskCoverage,
  };
}

export function listHarnessEvolutionRuns(
  targetRoot: string,
): HarnessEvolutionAdminState {
  const root = path.resolve(targetRoot);
  const runsDir = path.join(root, 'runs');
  if (!fs.existsSync(runsDir)) {
    return { targetRoot: root, runs: [] };
  }
  const runs = fs
    .readdirSync(runsDir)
    .map((entry) => readRunListEntry(path.join(runsDir, entry)))
    .filter((entry): entry is HarnessEvolutionRunListEntry => entry !== null)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  return { targetRoot: root, runs };
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

function writeRunListEntry(runDir: string, result: EvolutionRunResult): void {
  fs.writeFileSync(
    path.join(runDir, 'list-entry.json'),
    `${JSON.stringify(makeRunListEntry(result), null, 2)}\n`,
    'utf-8',
  );
}

export function calculateEvolutionMetrics(
  outcomes: EvolutionTaskOutcome[],
): EvolutionMetrics {
  const taskIds = new Set(outcomes.map((outcome) => outcome.taskId));
  const firstRollouts = new Map<string, EvolutionTaskOutcome>();
  let successCount = 0;
  let totalTokens = 0;
  let totalCostUsd = 0;
  for (const outcome of outcomes) {
    if (outcome.success) successCount += 1;
    totalTokens += Math.max(0, outcome.tokens);
    totalCostUsd += Math.max(0, outcome.costUsd || 0);
    const previous = firstRollouts.get(outcome.taskId);
    if (!previous || outcome.rollout < previous.rollout) {
      firstRollouts.set(outcome.taskId, outcome);
    }
  }
  const firstSuccesses = Array.from(firstRollouts.values()).filter(
    (outcome) => outcome.success,
  ).length;
  return {
    taskCount: taskIds.size,
    rolloutCount: outcomes.length,
    successCount,
    passAt1: taskIds.size > 0 ? firstSuccesses / taskIds.size : 0,
    succPerMtok: totalTokens > 0 ? successCount / (totalTokens / 1_000_000) : 0,
    totalTokens,
    totalCostUsd,
  };
}

export function readDebuggerReport(reportPath: string): string {
  const absolutePath = path.resolve(reportPath);
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`F11.4 debugger report was not found: ${reportPath}`);
  }
  const content = fs.readFileSync(absolutePath, 'utf-8');
  if (!content.trim()) {
    throw new Error(`F11.4 debugger report is empty: ${reportPath}`);
  }
  return content;
}

export async function runEvolveAgent(
  request: EvolveAgentRunRequest,
): Promise<EvolveAgentRunResult> {
  const { callAuxiliaryModel } = await import('../providers/auxiliary.js');
  const response = await callAuxiliaryModel({
    task: 'eval_judge',
    temperature: 0.2,
    maxTokens: 4_000,
    messages: [
      {
        role: 'system',
        content: EVOLVE_AGENT_SYSTEM_PROMPT,
      },
      {
        role: 'user',
        content: buildEvolveAgentPrompt(request),
      },
    ],
  });
  const outputPath = path.join(request.roundDir, 'evolve-agent-output.md');
  fs.writeFileSync(outputPath, `${response.content.trim()}\n`, 'utf-8');
  return {
    edits: extractF12EditsFromDebuggerReport(response.content),
    outputPath,
    provider: response.provider,
    model: response.model,
    ...(response.usage ? { usage: response.usage } : {}),
  };
}

async function resolveEvolutionEdits(params: {
  targetRoot: string;
  round: number;
  roundDir: string;
  manifestPath: string;
  reportPath: string;
  report: string;
  suite: EvolutionEvalSuite;
  outcomes: EvolutionTaskOutcome[];
  seedDelta: EvolutionSeedDelta;
  maxEditsPerRound: number;
  rejectedEdits: SkillOptRejectedEdit[];
  optimizerMemory: string;
  dryRun: boolean;
  providedEdits?: F12HarnessEdit[];
  evolveAgent: EvolveAgentRunner;
}): Promise<{
  edits: F12HarnessEdit[];
  roundResult: EvolutionRoundAgentResult;
}> {
  if (params.providedEdits) {
    return {
      edits: params.providedEdits,
      roundResult: {
        source: 'provided_edits',
        editCount: params.providedEdits.length,
        outputPath: null,
        provider: null,
        model: null,
      },
    };
  }
  const reportEdits = extractF12EditsFromDebuggerReport(params.report);
  if (reportEdits.length > 0) {
    return {
      edits: reportEdits,
      roundResult: {
        source: 'report_json',
        editCount: reportEdits.length,
        outputPath: params.reportPath,
        provider: null,
        model: null,
      },
    };
  }
  if (params.dryRun) {
    return {
      edits: [],
      roundResult: {
        source: 'dry_run_skipped',
        editCount: 0,
        outputPath: null,
        provider: null,
        model: null,
      },
    };
  }
  const result = await params.evolveAgent({
    targetRoot: params.targetRoot,
    round: params.round,
    roundDir: params.roundDir,
    reportPath: params.reportPath,
    report: params.report,
    suite: params.suite,
    outcomes: params.outcomes,
    seedDelta: params.seedDelta,
    maxEditsPerRound: params.maxEditsPerRound,
    rejectedEdits: params.rejectedEdits,
    optimizerMemory: params.optimizerMemory,
  });
  return {
    edits: result.edits,
    roundResult: {
      source: 'evolve_agent',
      editCount: result.edits.length,
      outputPath: result.outputPath,
      provider: result.provider,
      model: result.model,
      ...(result.usage ? { usage: result.usage } : {}),
    },
  };
}

function buildEvolveAgentPrompt(request: EvolveAgentRunRequest): string {
  const surfaceSnapshot = buildSurfaceSnapshot(request.targetRoot);
  const failedOutcomes = request.outcomes.filter((outcome) => !outcome.success);
  return [
    `Round: ${request.round}`,
    `Target root: ${request.targetRoot}`,
    `Suite: ${request.suite.name} (${request.suite.id})`,
    `Edit budget: at most ${request.maxEditsPerRound} bounded edit(s).`,
    `Seed delta: ${JSON.stringify(request.seedDelta, null, 2)}`,
    '',
    'Tool contract:',
    '```json',
    JSON.stringify(EVOLVE_AGENT_TOOLS, null, 2),
    '```',
    '',
    'Current harness snapshot (secrets redacted):',
    '```json',
    JSON.stringify(surfaceSnapshot, null, 2),
    '```',
    '',
    'Cleaned rollout failures:',
    '```json',
    JSON.stringify(failedOutcomes.slice(0, 20), null, 2),
    '```',
    '',
    'Rejected edit feedback:',
    '```json',
    JSON.stringify(request.rejectedEdits.slice(-20), null, 2),
    '```',
    '',
    'Optimizer meta skill memory:',
    request.optimizerMemory,
    '',
    'F11.4 debugger report:',
    request.report,
    '',
    'Return only a fenced JSON object with this shape:',
    '```json',
    JSON.stringify({ f12Edits: [EVOLVE_AGENT_TOOLS[1]?.inputSchema] }, null, 2),
    '```',
    'Use zero edits (`{"f12Edits":[]}`) when the evidence does not support a falsifiable change.',
  ].join('\n');
}

function buildSurfaceSnapshot(targetRoot: string): Record<string, unknown> {
  return {
    systemPrompt: readRedactedSurfaceFile(targetRoot, 'system_prompt.md'),
    toolsYaml: readRedactedSurfaceFile(targetRoot, 'tools.yaml'),
    directories: Object.fromEntries(
      DIRECTORY_SURFACES.map((surface) => [
        surface.relativePath,
        listDirectoryEntries(path.join(targetRoot, surface.relativePath)).map(
          (entry) => path.relative(targetRoot, entry).replaceAll('\\', '/'),
        ),
      ]),
    ),
  };
}

function readRedactedSurfaceFile(
  targetRoot: string,
  relativePath: string,
): string {
  const absolutePath = path.join(targetRoot, relativePath);
  if (!fs.existsSync(absolutePath)) return '';
  return redactSecrets(fs.readFileSync(absolutePath, 'utf-8')).slice(
    0,
    TRACE_TEXT_LIMIT,
  );
}

export function writeHarnessSurfaceFile(params: {
  targetRoot: string;
  manifestPath: string;
  round: number;
  relativePath: string;
  content: string;
  surface: HarnessSurface;
  prediction: string;
  verifier: string;
  rollbackScope: string;
  rationale?: string;
  appendManifest?: boolean;
}): F12HarnessManifestEntry {
  const resolved = resolveHarnessSurfacePath(
    params.targetRoot,
    params.relativePath,
  );
  if (resolved.surface !== params.surface) {
    throw new Error(
      `Declared surface ${params.surface} does not match ${params.relativePath}.`,
    );
  }
  const beforeContent = fs.existsSync(resolved.absolutePath)
    ? fs.readFileSync(resolved.absolutePath, 'utf-8')
    : null;
  const beforeHash = beforeContent === null ? null : hashText(beforeContent);
  const entry: F12HarnessManifestEntry = {
    id: `f12-${params.round}-${hashText(`${params.relativePath}\n${params.content}`).slice(0, 12)}`,
    round: params.round,
    surface: params.surface,
    path: normalizeRelativePath(params.relativePath),
    prediction: requireText(params.prediction, 'prediction'),
    verifier: requireText(params.verifier, 'verifier'),
    rollbackScope: requireText(params.rollbackScope, 'rollbackScope'),
    rationale: params.rationale?.trim() || null,
    beforeHash,
    afterHash: hashText(params.content),
    createdAt: new Date().toISOString(),
  };
  if (beforeContent !== null) {
    const snapshotPath = manifestEntrySnapshotPath(
      params.manifestPath,
      entry.id,
    );
    fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
    fs.writeFileSync(snapshotPath, beforeContent, 'utf-8');
  }
  fs.mkdirSync(path.dirname(resolved.absolutePath), { recursive: true });
  fs.writeFileSync(resolved.absolutePath, params.content, 'utf-8');
  if (params.appendManifest !== false) {
    appendManifestEntry(params.manifestPath, params.targetRoot, entry);
  }
  return entry;
}

function setManifestEntriesConfirmed(
  manifestPath: string,
  confirmed: boolean,
): void {
  const manifest = readHarnessEvolutionManifest(manifestPath);
  for (const entry of manifest.entries) {
    entry.confirmed = confirmed;
  }
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function exportHarnessSnapshot(targetRoot: string, exportRoot: string): void {
  fs.rmSync(exportRoot, { recursive: true, force: true });
  fs.mkdirSync(exportRoot, { recursive: true });
  for (const surface of HARNESS_SURFACES) {
    const sourcePath = path.join(targetRoot, surface.relativePath);
    const destinationPath = path.join(exportRoot, surface.relativePath);
    if (!fs.existsSync(sourcePath)) continue;
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    if (surface.kind === 'directory') {
      fs.cpSync(sourcePath, destinationPath, { recursive: true });
    } else {
      fs.copyFileSync(sourcePath, destinationPath);
    }
  }
}

function writeRejectedEdits(
  rejectedEditsPath: string,
  rejectedEdits: SkillOptRejectedEdit[],
): void {
  fs.writeFileSync(
    rejectedEditsPath,
    `${JSON.stringify({ rejectedEdits }, null, 2)}\n`,
    'utf-8',
  );
}

function updateOptimizerMemory(params: {
  previous: string;
  round: number;
  trainMetrics: EvolutionMetrics;
  selectionGate: SkillOptSelectionGate;
  proposedEditCount: number;
  selectedEditCount: number;
  rejectedEditCount: number;
  manifestEntries: F12HarnessManifestEntry[];
}): string {
  const kept = params.selectionGate.accepted ? 'kept' : 'rejected';
  const editSummary =
    params.manifestEntries.length === 0
      ? 'No bounded edits were applied.'
      : params.manifestEntries
          .map(
            (entry) =>
              `- ${entry.surface}:${entry.path} predicted "${entry.prediction}"`,
          )
          .join('\n');
  const nextBlock = [
    `## Round ${params.round}`,
    `- Train pass@1: ${formatNumber(params.trainMetrics.passAt1)}`,
    `- Selection pass@1: ${formatNumber(params.selectionGate.candidatePassAt1)} (${kept})`,
    `- Proposed edits: ${params.proposedEditCount}; selected edits: ${params.selectedEditCount}; rejected buffer size: ${params.rejectedEditCount}`,
    '- Evidence-backed edit notes:',
    editSummary,
  ].join('\n');
  const base = params.previous.includes('No rounds have completed yet.')
    ? '# SkillOpt Optimizer Memory\n'
    : params.previous.trimEnd();
  return `${base}\n\n${nextBlock}\n`;
}

function makeSelectionGate(params: {
  mode: SkillOptSelectionGate['mode'];
  accepted: boolean;
  reason: string;
  previousBestPassAt1: number;
  candidatePassAt1: number;
  trainTaskCount: number;
  selectionTaskCount: number;
  rejectedEditCount: number;
  selectionMetrics: EvolutionMetrics;
}): SkillOptSelectionGate {
  return {
    mode: params.mode,
    accepted: params.accepted,
    reason: params.reason,
    previousBestPassAt1: params.previousBestPassAt1,
    candidatePassAt1: params.candidatePassAt1,
    trainTaskCount: params.trainTaskCount,
    selectionTaskCount: params.selectionTaskCount,
    rejectedEditCount: params.rejectedEditCount,
    selectionMetrics: params.selectionMetrics,
  };
}

export async function runHarnessEvolutionLoop(
  options: HarnessEvolutionLoopOptions,
): Promise<EvolutionRunResult> {
  const targetRoot = path.resolve(options.targetRoot);
  const rounds = positiveInteger(
    options.rounds,
    DEFAULT_EVOLUTION_ROUNDS,
    'rounds',
  );
  const rolloutsPerTask = positiveInteger(
    options.rolloutsPerTask,
    DEFAULT_ROLLOUTS_PER_TASK,
    'rolloutsPerTask',
  );
  const maxEditsPerRound = positiveInteger(
    options.maxEditsPerRound,
    DEFAULT_SKILLOPT_MAX_EDITS_PER_ROUND,
    'maxEditsPerRound',
  );
  validateReportPathOption(options.reportPath, rounds);
  const runId = options.runId || makeRunId();
  const suite = loadEvolutionEvalSuite(options.suitePath);
  const selectionSuiteOption = options.selectionSuitePath
    ? loadEvolutionEvalSuite(options.selectionSuitePath)
    : undefined;
  const {
    trainSuite,
    selectionSuite,
    mode: selectionMode,
  } = resolveSkillOptSuites({
    suite,
    selectionSuite: selectionSuiteOption,
  });

  const workspaceValidation = options.freshSeed
    ? validateBashOnlySeed(targetRoot)
    : validateHarnessWorkspace(targetRoot);
  if (!workspaceValidation.ok) {
    throw new Error(workspaceValidation.errors.join('\n'));
  }
  const seedDelta = calculateSeedDelta(
    targetRoot,
    options.freshSeed ? 'fresh_seed' : 'in_place',
  );

  const runDir = path.join(targetRoot, 'runs', runId);
  fs.mkdirSync(runDir, { recursive: true });
  const bestPath = path.join(targetRoot, 'H_best.json');
  const bestHarnessPath = path.join(runDir, 'best-harness');
  const rejectedEditsPath = path.join(runDir, 'rejected-edits.json');
  const optimizerMemoryPath = path.join(runDir, 'optimizer-memory.md');
  const rejectedEdits: SkillOptRejectedEdit[] = [];
  let optimizerMemory =
    '# SkillOpt Optimizer Memory\n\nNo rounds have completed yet.\n';
  let bestPassAt1 = readBestPassAt1(bestPath);
  let bestRound: number | null = null;
  const roundResults: EvolutionRoundResult[] = [];
  let runCostUsd = 0;
  exportHarnessSnapshot(targetRoot, bestHarnessPath);
  writeRejectedEdits(rejectedEditsPath, rejectedEdits);
  fs.writeFileSync(optimizerMemoryPath, optimizerMemory, 'utf-8');

  for (let round = 1; round <= rounds; round += 1) {
    const roundDir = path.join(runDir, `round-${round}`);
    fs.mkdirSync(roundDir, { recursive: true });
    const rolloutsPath = path.join(roundDir, 'rollouts.json');
    const cleanedRolloutsPath = path.join(roundDir, 'cleaned-rollouts.json');
    const outcomes =
      options.outcomesByRound?.[round - 1] ||
      (await runSuiteRollouts({
        suite: trainSuite,
        rolloutsPerTask,
        targetRoot,
      }));
    const cleanedOutcomes = cleanOutcomes(outcomes);
    fs.writeFileSync(
      rolloutsPath,
      `${JSON.stringify(outcomes, null, 2)}\n`,
      'utf-8',
    );
    fs.writeFileSync(
      cleanedRolloutsPath,
      `${JSON.stringify(cleanedOutcomes, null, 2)}\n`,
      'utf-8',
    );

    const attribution = applyAttributionRollback({
      targetRoot,
      previousManifestPath:
        round > 1
          ? path.join(runDir, `round-${round - 1}`, 'f12-manifest.json')
          : null,
      disconfirmedEntryIds:
        round > 1 ? options.disconfirmedEntryIdsByRound?.[round - 2] || [] : [],
    });
    const attributionScore = attribution.score;
    fs.writeFileSync(
      path.join(roundDir, 'attribution.json'),
      `${JSON.stringify({ round, ...attribution }, null, 2)}\n`,
      'utf-8',
    );

    const reportPath = resolveRoundReportPath(
      options.reportPath,
      round,
      roundDir,
    );
    if (!fs.existsSync(reportPath)) {
      fs.writeFileSync(
        reportPath,
        buildDistilledDebuggerReport(trainSuite, round, cleanedOutcomes),
        'utf-8',
      );
    }
    const debuggerReport = readDebuggerReport(reportPath);
    const manifestPath = path.join(roundDir, 'f12-manifest.json');
    const evolveAgent = await resolveEvolutionEdits({
      targetRoot,
      round,
      roundDir,
      manifestPath,
      reportPath,
      report: debuggerReport,
      suite: trainSuite,
      outcomes: cleanedOutcomes,
      seedDelta,
      maxEditsPerRound,
      rejectedEdits,
      optimizerMemory,
      dryRun: Boolean(options.dryRun),
      providedEdits: options.editsByRound
        ? options.editsByRound[round - 1] || []
        : undefined,
      evolveAgent: options.evolveAgent || runEvolveAgent,
    });
    const edits = orderEvolutionEdits(evolveAgent.edits).slice(
      0,
      maxEditsPerRound,
    );
    const proposedEditCount = evolveAgent.edits.length;
    const editsPerSurface = zeroEditsPerSurface();
    const manifestEntries: F12HarnessManifestEntry[] = [];
    if (!options.dryRun) {
      for (const edit of edits) {
        const entry = writeHarnessSurfaceFile({
          targetRoot,
          manifestPath,
          round,
          appendManifest: false,
          ...edit,
        });
        manifestEntries.push(entry);
        editsPerSurface[edit.surface] += 1;
      }
    }
    writeHarnessManifest(manifestPath, targetRoot, manifestEntries);

    const metrics = calculateEvolutionMetrics(cleanedOutcomes);
    let selectionMetrics = metrics;
    let selectionRolloutsPath: string | null = null;
    let cleanedSelectionRolloutsPath: string | null = null;
    let selectionGate = makeSelectionGate({
      mode: options.dryRun ? 'dry_run' : selectionMode,
      accepted: false,
      reason: options.dryRun
        ? 'dry run records rollout metrics without applying edits'
        : 'no candidate edits were proposed',
      previousBestPassAt1: bestPassAt1,
      candidatePassAt1: metrics.passAt1,
      trainTaskCount: trainSuite.tasks.length,
      selectionTaskCount: selectionSuite.tasks.length,
      rejectedEditCount: 0,
      selectionMetrics,
    });

    if (!options.dryRun && edits.length > 0) {
      selectionRolloutsPath = path.join(roundDir, 'selection-rollouts.json');
      cleanedSelectionRolloutsPath = path.join(
        roundDir,
        'cleaned-selection-rollouts.json',
      );
      const selectionOutcomes =
        options.selectionOutcomesByRound?.[round - 1] ||
        (selectionMode === 'shared_suite'
          ? options.outcomesByRound?.[round - 1]
          : undefined) ||
        (await runSuiteRollouts({
          suite: selectionSuite,
          rolloutsPerTask,
          targetRoot,
        }));
      const cleanedSelectionOutcomes = cleanOutcomes(selectionOutcomes);
      fs.writeFileSync(
        selectionRolloutsPath,
        `${JSON.stringify(selectionOutcomes, null, 2)}\n`,
        'utf-8',
      );
      fs.writeFileSync(
        cleanedSelectionRolloutsPath,
        `${JSON.stringify(cleanedSelectionOutcomes, null, 2)}\n`,
        'utf-8',
      );
      selectionMetrics = calculateEvolutionMetrics(cleanedSelectionOutcomes);
      const accepted = selectionMetrics.passAt1 > bestPassAt1;
      selectionGate = makeSelectionGate({
        mode: selectionMode,
        accepted,
        reason: accepted
          ? 'candidate improved the selection gate'
          : 'candidate did not improve the selection gate',
        previousBestPassAt1: bestPassAt1,
        candidatePassAt1: selectionMetrics.passAt1,
        trainTaskCount: trainSuite.tasks.length,
        selectionTaskCount: selectionSuite.tasks.length,
        rejectedEditCount: accepted ? 0 : manifestEntries.length,
        selectionMetrics,
      });
      if (accepted) {
        setManifestEntriesConfirmed(manifestPath, true);
      } else {
        applyAttributionRollback({
          targetRoot,
          previousManifestPath: manifestPath,
          disconfirmedEntryIds: manifestEntries.map((entry) => entry.id),
        });
        for (const entry of manifestEntries) {
          rejectedEdits.push({
            round,
            path: entry.path,
            surface: entry.surface,
            prediction: entry.prediction,
            verifier: entry.verifier,
            reason: selectionGate.reason,
            rejectedAt: new Date().toISOString(),
          });
        }
        writeRejectedEdits(rejectedEditsPath, rejectedEdits);
      }
    }

    runCostUsd +=
      metrics.totalCostUsd +
      (selectionMetrics === metrics ? 0 : selectionMetrics.totalCostUsd);
    const improvedBest =
      selectionGate.accepted ||
      (Boolean(options.dryRun) && selectionMetrics.passAt1 > bestPassAt1);
    if (improvedBest) {
      bestPassAt1 = selectionMetrics.passAt1;
      bestRound = round;
      exportHarnessSnapshot(targetRoot, bestHarnessPath);
      fs.writeFileSync(
        bestPath,
        `${JSON.stringify(
          {
            runId,
            round,
            passAt1: bestPassAt1,
            selectionMode: selectionGate.mode,
            bestHarnessPath,
          },
          null,
          2,
        )}\n`,
        'utf-8',
      );
    }

    const gitCommit =
      options.commit && !options.dryRun
        ? commitEvolutionRound(targetRoot, round, runId)
        : null;
    optimizerMemory = updateOptimizerMemory({
      previous: optimizerMemory,
      round,
      trainMetrics: metrics,
      selectionGate,
      selectedEditCount: edits.length,
      proposedEditCount,
      rejectedEditCount: rejectedEdits.length,
      manifestEntries,
    });
    fs.writeFileSync(optimizerMemoryPath, optimizerMemory, 'utf-8');
    const roundResult: EvolutionRoundResult = {
      round,
      metrics,
      selectionGate,
      attributionScore,
      editsPerSurface,
      manifestPath,
      reportPath,
      evolveAgent: evolveAgent.roundResult,
      improvedBest,
      gitCommit,
      stages: {
        rollout: {
          status: 'completed',
          artifactPath: rolloutsPath,
          cleanedArtifactPath: cleanedRolloutsPath,
          taskCount: trainSuite.tasks.length,
          rolloutCount: cleanedOutcomes.length,
        },
        reflect: {
          status: 'completed',
          artifactPath: reportPath,
          failureCount: cleanedOutcomes.filter((outcome) => !outcome.success)
            .length,
        },
        aggregateSelect: {
          status: 'completed',
          proposedEditCount,
          selectedEditCount: edits.length,
          maxEdits: maxEditsPerRound,
        },
        update: {
          status: manifestEntries.length > 0 ? 'applied' : 'skipped',
          manifestPath,
          appliedEditCount: manifestEntries.length,
        },
        gate: {
          status: options.dryRun
            ? 'dry_run'
            : edits.length === 0
              ? 'skipped'
              : selectionGate.accepted
                ? 'accepted'
                : 'rejected',
          artifactPath: selectionRolloutsPath,
          cleanedArtifactPath: cleanedSelectionRolloutsPath,
          previousBestPassAt1: selectionGate.previousBestPassAt1,
          candidatePassAt1: selectionGate.candidatePassAt1,
        },
        memory: {
          status: 'updated',
          optimizerMemoryPath,
          rejectedEditCount: rejectedEdits.length,
        },
      },
    };
    roundResults.push(roundResult);
    fs.writeFileSync(
      path.join(roundDir, 'round-summary.json'),
      `${JSON.stringify(roundResult, null, 2)}\n`,
      'utf-8',
    );
    if (!evaluateCostGate(runCostUsd, suite.costBudgetUsd).ok) {
      break;
    }
  }

  const costGate = evaluateCostGate(runCostUsd, suite.costBudgetUsd);
  const summaryPath = path.join(runDir, 'summary.json');
  const result: EvolutionRunResult = {
    runId,
    targetRoot,
    suite: {
      ...suite,
      tasks: suite.tasks,
    },
    rounds: roundResults,
    bestPassAt1,
    bestRound,
    costGate,
    seedDelta,
    summaryPath,
    bestHarnessPath,
    rejectedEditsPath,
    optimizerMemoryPath,
  };
  fs.writeFileSync(
    summaryPath,
    `${JSON.stringify(result, null, 2)}\n`,
    'utf-8',
  );
  writeRunListEntry(runDir, result);
  return result;
}

export function renderEvolutionChart(result: EvolutionRunResult): string {
  const lines = [
    `Harness evolution run ${result.runId}`,
    `Target: ${result.targetRoot}`,
    `Suite: ${result.suite.name} (${result.suite.tasks.length} tasks)`,
    'Round | train pass@1 | selection pass@1 | gate | edits',
  ];
  for (const round of result.rounds) {
    const edits = Object.entries(round.editsPerSurface)
      .filter(([, count]) => count > 0)
      .map(([surface, count]) => `${surface}:${count}`)
      .join(', ');
    const gate =
      round.selectionGate.mode === 'dry_run'
        ? 'dry-run'
        : round.selectionGate.accepted
          ? 'accepted'
          : 'rejected';
    lines.push(
      [
        round.round.toString().padStart(5),
        formatNumber(round.metrics.passAt1).padStart(12),
        formatNumber(round.selectionGate.candidatePassAt1).padStart(16),
        gate.padStart(8),
        edits || 'none',
      ].join(' | '),
    );
    lines.push(`      manifest: ${round.manifestPath}`);
  }
  lines.push(
    `Best: ${result.bestRound === null ? 'none' : `round ${result.bestRound}`} pass@1=${formatNumber(result.bestPassAt1)}`,
  );
  lines.push(`Best harness: ${result.bestHarnessPath}`);
  lines.push(`Rejected edit buffer: ${result.rejectedEditsPath}`);
  if (!result.costGate.ok && result.costGate.reason) {
    lines.push(`Cost gate: failed (${result.costGate.reason})`);
  } else if (result.costGate.budgetUsd !== null) {
    lines.push(
      `Cost gate: ok (${formatNumber(result.costGate.totalCostUsd)}/${formatNumber(result.costGate.budgetUsd)} USD)`,
    );
  }
  lines.push(formatRiskCoverage(result.suite.riskCoverage));
  lines.push(
    `Seed delta: ${result.seedDelta.mode === 'fresh_seed' ? 'fresh seed' : 'in-place'} ${result.seedDelta.changedSurfaceCount}/${HARNESS_SURFACES.length} surfaces changed (${result.seedDelta.fileCount} files)`,
  );
  return lines.join('\n');
}

function formatRiskCoverage(coverage: HarnessRiskCoverage): string {
  const groups = [
    `NIST RMF ${coverage.nistAiRmf.coveredCount}/${coverage.nistAiRmf.totalCount}`,
    `NIST GAI ${coverage.nistGaiProfile.coveredCount}/${coverage.nistGaiProfile.totalCount}`,
    `OWASP LLM ${coverage.owaspLlmTop10.coveredCount}/${coverage.owaspLlmTop10.totalCount}`,
  ];
  return `Risk coverage: ${groups.join('; ')}`;
}

function normalizeRelativePath(relativePath: string): string {
  const normalized = relativePath.replaceAll('\\', '/').replace(/^\/+/, '');
  if (!normalized || normalized.includes('\0')) {
    throw new Error(`Invalid harness path: ${relativePath}`);
  }
  if (normalized.split('/').some((part) => part === '..')) {
    throw new Error(`Harness path cannot contain traversal: ${relativePath}`);
  }
  return normalized;
}

function assertNoSymlinkEscape(
  targetRoot: string,
  normalizedRelative: string,
  absolutePath: string,
): void {
  const rootReal = fs.realpathSync(targetRoot);
  let current = targetRoot;
  for (const part of normalizedRelative.split('/')) {
    current = path.join(current, part);
    if (!fs.existsSync(current)) break;
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw new Error(
        `Harness path cannot traverse symlink: ${normalizedRelative}`,
      );
    }
  }

  const existingParent = nearestExistingParent(absolutePath);
  const parentReal = fs.realpathSync(existingParent);
  if (
    parentReal !== rootReal &&
    !parentReal.startsWith(`${rootReal}${path.sep}`)
  ) {
    throw new Error(
      `Harness path resolves outside target workspace: ${normalizedRelative}`,
    );
  }
}

function nearestExistingParent(absolutePath: string): string {
  let current = fs.existsSync(absolutePath)
    ? fs.statSync(absolutePath).isDirectory()
      ? absolutePath
      : path.dirname(absolutePath)
    : path.dirname(absolutePath);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return parent;
    current = parent;
  }
  return current;
}

function calculateSeedDelta(
  targetRoot: string,
  mode: EvolutionSeedDelta['mode'],
): EvolutionSeedDelta {
  const changedSurfaces: HarnessSurface[] = [];
  const notes: string[] = [];
  let fileCount = 0;

  for (const surface of HARNESS_SURFACES) {
    const surfacePath = path.join(targetRoot, surface.relativePath);
    if (surface.kind === 'file') {
      const content = fs.existsSync(surfacePath)
        ? fs.readFileSync(surfacePath, 'utf-8')
        : '';
      const changed =
        surface.surface === 'system_prompt'
          ? content !== DEFAULT_SYSTEM_PROMPT
          : !isMinimalToolsYaml(content);
      if (changed) {
        changedSurfaces.push(surface.surface);
        fileCount += 1;
        notes.push(`${surface.relativePath} differs from the bash-only seed.`);
      }
      continue;
    }

    const entries = listDirectoryEntries(surfacePath);
    if (entries.length > 0) {
      changedSurfaces.push(surface.surface);
      fileCount += entries.length;
      notes.push(`${surface.relativePath}/ has ${entries.length} file(s).`);
    }
  }

  return {
    mode,
    changedSurfaceCount: changedSurfaces.length,
    changedSurfaces,
    fileCount,
    notes,
  };
}

function isMinimalToolsYaml(content: string): boolean {
  const raw = content.trim();
  if (!raw) return true;
  try {
    const tools = extractToolsArray(YAML.parse(raw) as unknown);
    return tools !== null && tools.length === 0;
  } catch {
    return false;
  }
}

function listDirectoryEntries(directoryPath: string): string[] {
  if (!fs.existsSync(directoryPath)) return [];
  const entries: string[] = [];
  for (const entry of fs.readdirSync(directoryPath)) {
    if (IGNORED_EMPTY_MARKERS.has(entry)) continue;
    const absolutePath = path.join(directoryPath, entry);
    const stat = fs.lstatSync(absolutePath);
    if (stat.isSymbolicLink()) {
      entries.push(absolutePath);
      continue;
    }
    if (stat.isDirectory()) {
      entries.push(...listDirectoryEntries(absolutePath));
    } else {
      entries.push(absolutePath);
    }
  }
  return entries;
}

function resolveSuitePath(suitePath: string): string {
  const absolutePath = path.resolve(suitePath);
  if (fs.existsSync(absolutePath) && fs.statSync(absolutePath).isFile()) {
    return absolutePath;
  }
  if (fs.existsSync(absolutePath) && fs.statSync(absolutePath).isDirectory()) {
    const candidates = [
      path.join(absolutePath, 'evals', 'scenarios.json'),
      path.join(absolutePath, 'scenarios.json'),
      path.join(absolutePath, 'suite.json'),
    ];
    const found = candidates.find((candidate) => fs.existsSync(candidate));
    if (found) return found;
  }
  throw new Error(
    `Eval suite was not found. Expected a suite JSON file or a skill directory with evals/scenarios.json: ${suitePath}`,
  );
}

function parseEvalTask(task: unknown, index: number): EvolutionEvalTask {
  if (!task || typeof task !== 'object') {
    throw new Error(`Eval task ${index + 1} must be a JSON object.`);
  }
  const record = task as Record<string, unknown>;
  const id = readString(record.id) || readString(record.name);
  if (!id) {
    throw new Error(`Eval task ${index + 1} is missing id or name.`);
  }
  return {
    id: normalizeId(id),
    skill: readString(record.skill),
    expected: readString(record.expected),
    command: readString(record.command),
    timeoutMs: readNumber(record.timeoutMs),
    riskReferences: parseAgentRiskReferences(record),
    split: parseTaskSplit(record.split ?? record.phase ?? record.subset),
  };
}

function parseTaskSplit(value: unknown): EvolutionEvalTask['split'] {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (
    normalized === 'train' ||
    normalized === 'selection' ||
    normalized === 'test'
  ) {
    return normalized;
  }
  throw new Error(`Unsupported eval task split: ${value}`);
}

function makeSuiteWithTasks(
  suite: EvolutionEvalSuite,
  tasks: EvolutionEvalTask[],
  suffix: string,
): EvolutionEvalSuite {
  const riskCoverage = calculateHarnessRiskCoverage(
    tasks,
    suite.riskCoverageRequirements,
  );
  return {
    ...suite,
    id: `${suite.id}-${suffix}`,
    name: `${suite.name} (${suffix})`,
    tasks,
    riskCoverage,
  };
}

function resolveSkillOptSuites(params: {
  suite: EvolutionEvalSuite;
  selectionSuite?: EvolutionEvalSuite;
}): {
  trainSuite: EvolutionEvalSuite;
  selectionSuite: EvolutionEvalSuite;
  mode: SkillOptSelectionGate['mode'];
} {
  if (params.selectionSuite) {
    return {
      trainSuite: params.suite,
      selectionSuite: params.selectionSuite,
      mode: 'held_out_suite',
    };
  }

  const trainTasks = params.suite.tasks.filter(
    (task) => task.split !== 'selection' && task.split !== 'test',
  );
  const selectionTasks = params.suite.tasks.filter(
    (task) => task.split === 'selection',
  );
  if (selectionTasks.length > 0) {
    if (trainTasks.length === 0) {
      throw new Error(
        'Eval suite split declares selection tasks but no train tasks.',
      );
    }
    return {
      trainSuite: makeSuiteWithTasks(params.suite, trainTasks, 'train'),
      selectionSuite: makeSuiteWithTasks(
        params.suite,
        selectionTasks,
        'selection',
      ),
      mode: 'task_split',
    };
  }

  return {
    trainSuite: params.suite,
    selectionSuite: params.suite,
    mode: 'shared_suite',
  };
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, value)
    : undefined;
}

function normalizeId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function hashText(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function requireText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`F12 manifest entry requires ${label}.`);
  }
  return normalized;
}

function appendManifestEntry(
  manifestPath: string,
  targetRoot: string,
  entry: F12HarnessManifestEntry,
): void {
  const manifest = fs.existsSync(manifestPath)
    ? readHarnessEvolutionManifest(manifestPath)
    : makeHarnessManifest(targetRoot);
  manifest.entries.push(entry);
  writeHarnessManifest(manifestPath, targetRoot, manifest.entries);
}

function makeHarnessManifest(
  targetRoot: string,
  entries: F12HarnessManifestEntry[] = [],
): F12HarnessManifest {
  return {
    schemaVersion: HARNESS_EVOLUTION_SCHEMA_VERSION,
    targetRoot: path.resolve(targetRoot),
    entries,
  };
}

function writeHarnessManifest(
  manifestPath: string,
  targetRoot: string,
  entries: F12HarnessManifestEntry[],
): void {
  const manifest = makeHarnessManifest(targetRoot, entries);
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf-8',
  );
}

function manifestEntrySnapshotPath(
  manifestPath: string,
  entryId: string,
): string {
  return path.join(path.dirname(manifestPath), 'before', `${entryId}.txt`);
}

function positiveInteger(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
}

function makeRunId(): string {
  return `evolve-${new Date().toISOString().replace(/[:.]/g, '-')}`;
}

function resolveRoundReportPath(
  reportPath: string | undefined,
  round: number,
  roundDir: string,
): string {
  if (!reportPath) return path.join(roundDir, 'f114-debugger-report.md');
  const resolved = path.resolve(reportPath);
  if (reportPath.includes('{round}')) {
    return path.resolve(reportPath.replaceAll('{round}', String(round)));
  }
  if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
    return path.join(resolved, `round-${round}-f114-debugger-report.md`);
  }
  if (!path.extname(resolved)) {
    fs.mkdirSync(resolved, { recursive: true });
    return path.join(resolved, `round-${round}-f114-debugger-report.md`);
  }
  return resolved;
}

function validateReportPathOption(
  reportPath: string | undefined,
  rounds: number,
): void {
  if (!reportPath || rounds <= 1 || reportPath.includes('{round}')) return;
  const resolved = path.resolve(reportPath);
  if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) return;
  if (!path.extname(resolved)) return;
  if (rounds > 1) {
    throw new Error(
      'reportPath must be a directory or include `{round}` when running multiple rounds.',
    );
  }
}

function buildDistilledDebuggerReport(
  suite: EvolutionEvalSuite,
  round: number,
  outcomes: EvolutionTaskOutcome[],
): string {
  const failed = outcomes.filter((outcome) => !outcome.success);
  return [
    `# F11.4 Agent Debugger Report`,
    '',
    `Suite: ${suite.name}`,
    `Round: ${round}`,
    '',
    '## Symptoms',
    failed.length === 0
      ? '- All cleaned rollouts passed.'
      : `- ${failed.length} cleaned rollout${failed.length === 1 ? '' : 's'} failed.`,
    '',
    '## Root Cause Candidates',
    ...summarizeFailedOutcomes(failed),
    '',
    '## Recommended F12 Edits',
    '- Add falsifiable edits only when evaluator evidence supports them.',
    '',
  ].join('\n');
}

function summarizeFailedOutcomes(outcomes: EvolutionTaskOutcome[]): string[] {
  if (outcomes.length === 0) return ['- No root-cause candidates.'];
  return outcomes.slice(0, 10).map((outcome) => {
    const stderr = outcome.stderr?.trim().split(/\r?\n/u)[0] || '';
    return `- ${outcome.taskId} rollout ${outcome.rollout} failed${outcome.exitCode == null ? '' : ` with exit ${outcome.exitCode}`}${stderr ? `: ${stderr}` : '.'}`;
  });
}

function runSuiteRollouts(params: {
  suite: EvolutionEvalSuite;
  rolloutsPerTask: number;
  targetRoot: string;
}): Promise<EvolutionTaskOutcome[]> {
  const missingCommand = params.suite.tasks.find((task) => !task.command);
  if (missingCommand) {
    throw new Error(
      `Eval task "${missingCommand.id}" is missing command; harness evolution requires concrete eval commands or test-provided outcomes.`,
    );
  }
  return runCommandBackedOutcomes(
    params.suite,
    params.rolloutsPerTask,
    params.targetRoot,
  );
}

function runCommandBackedOutcomes(
  suite: EvolutionEvalSuite,
  rolloutsPerTask: number,
  targetRoot: string,
): Promise<EvolutionTaskOutcome[]> {
  const outcomes: Array<Promise<EvolutionTaskOutcome>> = [];
  for (const task of suite.tasks) {
    for (let rollout = 1; rollout <= rolloutsPerTask; rollout += 1) {
      outcomes.push(runCommandBackedOutcome(suite, task, rollout, targetRoot));
    }
  }
  return Promise.all(outcomes);
}

function runCommandBackedOutcome(
  suite: EvolutionEvalSuite,
  task: EvolutionEvalTask,
  rollout: number,
  targetRoot: string,
): Promise<EvolutionTaskOutcome> {
  const commandParts = splitCommand(task.command || '').map((part) =>
    part.replaceAll('{targetRoot}', targetRoot),
  );
  const executable = commandParts[0];
  if (!executable) {
    throw new Error(`Eval task "${task.id}" is missing command.`);
  }
  const startedAt = Date.now();
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let processError: string | null = null;
    const child = spawn(executable, commandParts.slice(1), {
      shell: false,
      env: {
        ...process.env,
        HYBRIDCLAW_EVOLUTION_TASK_ID: task.id,
        HYBRIDCLAW_EVOLUTION_ROLLOUT: String(rollout),
        HYBRIDCLAW_EVOLUTION_SUITE_ID: suite.id,
        HYBRIDCLAW_EVOLUTION_TARGET_ROOT: targetRoot,
      },
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, task.timeoutMs || 120_000);

    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const timeoutMessage = timedOut ? 'Process timed out.' : '';
      const stdoutClean = cleanTraceText(stdout);
      const stderrClean = cleanTraceText(
        [stderr, processError, timeoutMessage].filter(Boolean).join('\n'),
      );
      resolve({
        taskId: task.id,
        rollout,
        success: exitCode === 0 && !processError && !timedOut,
        tokens: estimateTokens(`${stdoutClean}\n${stderrClean}`),
        costUsd: 0,
        exitCode,
        stdout: stdoutClean,
        stderr: stderrClean,
        durationMs: Date.now() - startedAt,
      });
    };

    child.stdout.on('data', (chunk: Buffer) => {
      stdout = appendCappedTrace(stdout, chunk.toString('utf-8'));
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = appendCappedTrace(stderr, chunk.toString('utf-8'));
    });
    child.on('error', (error) => {
      processError = error.message;
      finish(null);
    });
    child.on('close', (code) => finish(code));
  });
}

function splitCommand(command: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (const char of command.trim()) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/u.test(char)) {
      if (current) {
        parts.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (escaped) current += '\\';
  if (quote) throw new Error(`Unterminated quote in eval command: ${command}`);
  if (current) parts.push(current);
  return parts;
}

function appendCappedTrace(previous: string, next: string): string {
  if (previous.length >= TRACE_TEXT_LIMIT) return previous;
  return `${previous}${next}`.slice(0, TRACE_TEXT_LIMIT);
}

function cleanOutcomes(
  outcomes: EvolutionTaskOutcome[],
): EvolutionTaskOutcome[] {
  return outcomes.map((outcome) => ({
    taskId: outcome.taskId,
    rollout: outcome.rollout,
    success: outcome.success,
    tokens: Math.max(0, Math.floor(outcome.tokens)),
    ...(outcome.exitCode === undefined ? {} : { exitCode: outcome.exitCode }),
    ...(outcome.stdout === undefined
      ? {}
      : { stdout: cleanTraceText(outcome.stdout) }),
    ...(outcome.stderr === undefined
      ? {}
      : { stderr: cleanTraceText(outcome.stderr) }),
    ...(outcome.durationMs === undefined
      ? {}
      : { durationMs: Math.max(0, Math.floor(outcome.durationMs)) }),
    ...(outcome.costUsd === undefined
      ? {}
      : { costUsd: Math.max(0, outcome.costUsd) }),
  }));
}

function cleanTraceText(value: string): string {
  const seen = new Set<string>();
  return value
    .slice(0, TRACE_TEXT_LIMIT)
    .split(/\r?\n/u)
    .map((line) =>
      line.replace(/\b[A-Za-z0-9+/]{120,}={0,2}\b/g, '[base64 elided]'),
    )
    .filter((line) => {
      const key = line.trim();
      if (!key) return true;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .join('\n');
}

function estimateTokens(text: string): number {
  const normalized = text.trim();
  if (!normalized) return 1;
  return Math.max(1, Math.ceil(normalized.length / 4));
}

function extractF12EditsFromDebuggerReport(report: string): F12HarnessEdit[] {
  const fenced = report.match(/```(?:json)?\s*([\s\S]*?)```/u);
  const raw = fenced?.[1]?.trim() || report.trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    const edits = Array.isArray(parsed)
      ? parsed
      : parsed &&
          typeof parsed === 'object' &&
          Array.isArray((parsed as { f12Edits?: unknown }).f12Edits)
        ? (parsed as { f12Edits: unknown[] }).f12Edits
        : [];
    return edits
      .map(parseDebuggerReportEdit)
      .filter(
        (
          edit,
        ): edit is NonNullable<ReturnType<typeof parseDebuggerReportEdit>> =>
          Boolean(edit),
      );
  } catch {
    return [];
  }
}

function parseDebuggerReportEdit(value: unknown): F12HarnessEdit | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const surface = readString(record.surface) as HarnessSurface | undefined;
  if (
    !surface ||
    !HARNESS_SURFACES.some((entry) => entry.surface === surface)
  ) {
    return null;
  }
  const relativePath =
    readString(record.relativePath) || readString(record.path);
  const content = readString(record.content);
  const prediction = readString(record.prediction);
  const verifier = readString(record.verifier);
  const rollbackScope = readString(record.rollbackScope);
  if (!relativePath || !content || !prediction || !verifier || !rollbackScope) {
    return null;
  }
  return {
    surface,
    relativePath,
    content,
    prediction,
    verifier,
    rollbackScope,
    rationale: readString(record.rationale),
  };
}

function orderEvolutionEdits(edits: F12HarnessEdit[]): F12HarnessEdit[] {
  return [...edits].sort(
    (left, right) =>
      EVOLVE_SURFACE_ORDER[left.surface] - EVOLVE_SURFACE_ORDER[right.surface],
  );
}

function applyAttributionRollback(params: {
  targetRoot: string;
  previousManifestPath: string | null;
  disconfirmedEntryIds: string[];
}): {
  score: number;
  verifiedEntries: number;
  rolledBackEntries: number;
  rolledBackPaths: string[];
} {
  if (
    !params.previousManifestPath ||
    !fs.existsSync(params.previousManifestPath)
  ) {
    return {
      score: 1,
      verifiedEntries: 0,
      rolledBackEntries: 0,
      rolledBackPaths: [],
    };
  }
  const manifest = readHarnessEvolutionManifest(params.previousManifestPath);
  const disconfirmed = new Set(params.disconfirmedEntryIds);
  const rolledBackPaths: string[] = [];
  for (const entry of manifest.entries) {
    if (!disconfirmed.has(entry.id)) {
      entry.confirmed = true;
      continue;
    }
    const rollbackTarget = resolveHarnessSurfacePath(
      params.targetRoot,
      entry.rollbackScope,
    );
    if (fs.existsSync(rollbackTarget.absolutePath)) {
      const stat = fs.lstatSync(rollbackTarget.absolutePath);
      if (stat.isDirectory()) {
        fs.rmSync(rollbackTarget.absolutePath, {
          recursive: true,
          force: true,
        });
      } else {
        fs.rmSync(rollbackTarget.absolutePath, { force: true });
      }
    }
    const resolved = resolveHarnessSurfacePath(params.targetRoot, entry.path);
    const snapshotPath = manifestEntrySnapshotPath(
      params.previousManifestPath,
      entry.id,
    );
    if (!fs.existsSync(snapshotPath)) {
      if (fs.existsSync(resolved.absolutePath)) {
        fs.rmSync(resolved.absolutePath);
      }
    } else {
      fs.mkdirSync(path.dirname(resolved.absolutePath), { recursive: true });
      fs.writeFileSync(
        resolved.absolutePath,
        fs.readFileSync(snapshotPath, 'utf-8'),
        'utf-8',
      );
    }
    entry.confirmed = false;
    entry.rolledBackAt = new Date().toISOString();
    rolledBackPaths.push(entry.path);
  }
  fs.writeFileSync(
    params.previousManifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf-8',
  );
  const verifiedEntries = manifest.entries.length;
  const rolledBackEntries = rolledBackPaths.length;
  return {
    score:
      verifiedEntries > 0
        ? (verifiedEntries - rolledBackEntries) / verifiedEntries
        : 1,
    verifiedEntries,
    rolledBackEntries,
    rolledBackPaths,
  };
}

function zeroEditsPerSurface(): Record<HarnessSurface, number> {
  return Object.fromEntries(
    HARNESS_SURFACES.map((surface) => [surface.surface, 0]),
  ) as Record<HarnessSurface, number>;
}

function readBestPassAt1(bestPath: string): number {
  if (!fs.existsSync(bestPath)) return 0;
  try {
    const parsed = JSON.parse(fs.readFileSync(bestPath, 'utf-8')) as {
      passAt1?: unknown;
    };
    return typeof parsed.passAt1 === 'number' && Number.isFinite(parsed.passAt1)
      ? parsed.passAt1
      : 0;
  } catch {
    return 0;
  }
}

function evaluateCostGate(
  totalCostUsd: number,
  budgetUsd: number | undefined,
): EvolutionCostGate {
  if (budgetUsd === undefined) {
    return {
      ok: true,
      totalCostUsd,
      budgetUsd: null,
      reason: null,
    };
  }
  return {
    ok: totalCostUsd <= budgetUsd,
    totalCostUsd,
    budgetUsd,
    reason:
      totalCostUsd <= budgetUsd
        ? null
        : `run cost ${totalCostUsd.toFixed(4)} exceeds budget ${budgetUsd.toFixed(4)}`,
  };
}

function commitEvolutionRound(
  targetRoot: string,
  round: number,
  runId: string,
): string | null {
  const stagePaths = [
    ...HARNESS_SURFACES.map((surface) => surface.relativePath),
    'H_best.json',
    'runs',
  ];
  const add = spawnSync('git', ['add', ...stagePaths], {
    cwd: targetRoot,
    encoding: 'utf-8',
  });
  if (add.status !== 0) {
    throw new Error(
      add.stderr.trim() || 'Failed to stage harness evolution round.',
    );
  }
  const commit = spawnSync(
    'git',
    ['commit', '-m', `chore: evolve harness ${runId} round ${round}`],
    {
      cwd: targetRoot,
      encoding: 'utf-8',
    },
  );
  if (commit.status !== 0) {
    const stderr = commit.stderr.trim();
    if (/nothing to commit/i.test(stderr)) return null;
    throw new Error(stderr || 'Failed to commit harness evolution round.');
  }
  const revParse = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: targetRoot,
    encoding: 'utf-8',
  });
  if (revParse.status !== 0) return null;
  return revParse.stdout.trim() || null;
}

function formatNumber(value: number): string {
  return METRIC_NUMBER_FORMATTER.format(value);
}
