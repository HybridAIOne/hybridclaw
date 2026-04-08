import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_CONCURRENT_CONTAINERS } from '../config/config.js';
import { isContainerMaxConcurrentExplicit } from '../config/runtime-config.js';
import type { GatewayCommandResult } from '../gateway/gateway-types.js';
import {
  enqueueProactiveMessage,
  isDatabaseInitialized,
} from '../memory/db.js';
import {
  buildDefaultEvalProfile,
  describeEvalProfile,
  type EvalProfile,
  encodeEvalProfileModel,
  isKnownEvalPromptPart,
} from './eval-profile.js';

type EvalSuiteId =
  | 'swebench-verified'
  | 'terminal-bench-2.0'
  | 'agentbench'
  | 'gaia';

interface EvalSuiteDefinition {
  id: EvalSuiteId;
  title: string;
  summary: string;
  aliases: string[];
  prereqs: string[];
  starter: string[];
  notes: string[];
}

interface ManagedEvalSuiteSetup {
  installDirName: string;
  strategyDescription: string;
}

interface ManagedSuiteRunPreparation {
  commandArgs: string[];
  command: string;
  displayCommand: string;
  cwd: string;
}

interface EvalEnvironment {
  baseUrl: string;
  apiKey: string;
  model: string;
  baseModel: string;
  authMode: 'web-token' | 'loopback';
  profile: EvalProfile;
}

export interface HandleEvalCommandParams {
  args: string[];
  dataDir: string;
  gatewayBaseUrl: string;
  webApiToken: string;
  effectiveModel: string;
  effectiveAgentId?: string;
  channelId?: string;
}

interface EvalProgressSpec {
  kind: 'tau2';
  label: string;
  total: number | null;
  unit: string;
}

interface EvalRunPreparation {
  commandArgs: string[];
  command: string;
  progress: EvalProgressSpec | null;
}

interface EvalSetupCommand {
  command: string;
  strategy: 'uv' | 'system-python';
}

interface EvalRunMeta {
  runId: string;
  suiteId?: string;
  operation?: string;
  pid: number | null;
  startedAt: string;
  finishedAt?: string | null;
  exitCode?: number | null;
  exitSignal?: string | null;
  cwd: string;
  command: string;
  displayCommand?: string;
  openaiBaseUrl: string;
  model: string;
  baseModel: string;
  authMode: EvalEnvironment['authMode'];
  profile: EvalProfile;
  stdoutPath: string;
  stderrPath: string;
  progress?: {
    kind: EvalProgressSpec['kind'];
    label: string;
    unit: string;
    total: number | null;
    completed: number;
    status: 'running' | 'exited';
    updatedAt: string;
  };
}

interface Tau2RunSummary {
  totalTasks: number | null;
  totalSimulations: number | null;
  averageReward: string | null;
  passRate: string | null;
  rewardPassed: number | null;
  dbMatched: number;
  dbMismatched: number;
  dbTotal: number;
  dbMatchPercent: string;
  normalStop: number | null;
}

interface TerminalBenchNativeReward {
  taskName?: string;
  category?: string;
  reward?: number;
  passed?: boolean;
  turnsUsed?: number;
  finishedNaturally?: boolean;
  error?: string;
}

interface TerminalBenchNativeSummary {
  jobDir: string;
  resultPath: string;
  agent: string | null;
  dataset: string | null;
  trials: number;
  errors: number;
  mean: number;
  passed: number;
  rewards: TerminalBenchNativeReward[];
  tokenUsage: TerminalBenchNativeTokenUsage | null;
}

interface TerminalBenchNativeProgress {
  jobDir: string;
  totalTasks: number | null;
  started: number;
  finished: number;
  passed: number;
  failed: number;
  running: number;
  pending: number | null;
  tokenUsage: TerminalBenchNativeTokenUsage | null;
}

interface TerminalBenchNativeTokenUsage {
  modelCalls: number;
  apiPromptTokens: number;
  apiCompletionTokens: number;
  apiTotalTokens: number;
  estimatedPromptTokens: number;
  estimatedCompletionTokens: number;
  estimatedTotalTokens: number;
  apiUsageAvailable: boolean;
}

const MAX_QUEUED_EVAL_MESSAGES = 200;
const EVAL_PROGRESS_BAR_WIDTH = 20;
const EVAL_PROGRESS_POLL_INTERVAL_MS = 1000;
const EVAL_EARLY_EXIT_CHECK_MS = 1500;
const TAU2_REPO_URL = 'https://github.com/sierra-research/tau2-bench';
const TAU2_INSTALL_DIRNAME = 'tau2-bench';
let cachedHarnessVersion: string | null = null;
const MANAGED_SUITE_SUBCOMMANDS = new Set([
  'setup',
  'run',
  'status',
  'stop',
  'results',
  'logs',
]);

const EVAL_SUITES: EvalSuiteDefinition[] = [
  {
    id: 'swebench-verified',
    title: 'SWE-bench Verified',
    summary:
      'Verifier recipe for the 500-task human-validated SWE-bench Verified subset.',
    aliases: ['swebench', 'swe-bench', 'swe-bench-verified'],
    prereqs: ['Python', 'Docker', '`pip install swebench`'],
    starter: [
      'python -m swebench.harness.run_evaluation \\',
      '  --dataset_name princeton-nlp/SWE-bench_Verified \\',
      '  --predictions_path <your_patches.jsonl> \\',
      '  --max_workers 8 \\',
      '  --run_id hybridclaw_run',
    ],
    notes: [
      'This step evaluates a predictions JSONL; produce patches with your HybridClaw-driven harness first.',
      '`/eval ...` injects the OpenAI-compatible HybridClaw endpoint for any predictor step you run through this helper.',
    ],
  },
  {
    id: 'terminal-bench-2.0',
    title: 'Terminal-Bench 2.0',
    summary:
      'Sandboxed terminal-task benchmark run through a native HybridClaw harness runner.',
    aliases: ['terminal-bench', 'terminal-bench-2', 'terminalbench'],
    prereqs: ['Python', 'Docker', '`pip install datasets`'],
    starter: [
      '/eval terminal-bench-2.0 setup',
      '/eval terminal-bench-2.0 run --num-tasks 10',
    ],
    notes: [
      'This native runner exercises HybridClaw’s own tool loop instead of Harbor Terminus2.',
      'Each task runs against its own Docker task container, with HybridClaw file and shell tools operating on the same `/app` workspace.',
    ],
  },
  {
    id: 'agentbench',
    title: 'AgentBench',
    summary: 'Broad multi-environment benchmark driven by YAML config.',
    aliases: ['agent-bench'],
    prereqs: [
      'Python',
      'Docker',
      '`git clone https://github.com/THUDM/AgentBench`',
      '`pip install -r requirements.txt` inside the cloned repo',
    ],
    starter: ['python eval.py --config configs/your_agent_config.yaml'],
    notes: [
      'Point your AgentBench YAML config at `$OPENAI_BASE_URL`, use `$OPENAI_API_KEY`, and set the model id to `$HYBRIDCLAW_EVAL_MODEL`.',
      'This command does not manage the per-environment Docker setup from AgentBench itself.',
    ],
  },
  {
    id: 'gaia',
    title: 'GAIA',
    summary: 'General-purpose assistant reasoning benchmark via Inspect AI.',
    aliases: [],
    prereqs: ['Python', '`pip install inspect-ai inspect-evals`'],
    starter: [
      'inspect eval inspect_evals/gaia \\',
      '  --model "$HYBRIDCLAW_EVAL_MODEL" \\',
      '  --log-dir ./logs',
    ],
    notes: [
      'If your local Inspect AI install expects an explicit OpenAI-compatible provider prefix, keep the same base URL and API key but adapt the model flag accordingly.',
    ],
  },
];

function infoResult(title: string, text: string): GatewayCommandResult {
  return { kind: 'info', title, text };
}

function errorResult(title: string, text: string): GatewayCommandResult {
  return { kind: 'error', title, text };
}

function buildOpenAIBaseUrl(gatewayBaseUrl: string): string {
  const trimmed = gatewayBaseUrl.trim().replace(/\/+$/, '');
  if (!trimmed) return 'http://127.0.0.1:9090/v1';
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
}

function buildEvalEnvironment(params: {
  gatewayBaseUrl: string;
  webApiToken: string;
  effectiveModel: string;
  profile: EvalProfile;
}): EvalEnvironment {
  const token = params.webApiToken.trim();
  const baseModel = params.effectiveModel.trim() || 'hybridai/gpt-4.1-mini';
  return {
    baseUrl: buildOpenAIBaseUrl(params.gatewayBaseUrl),
    apiKey: token || 'hybridclaw-local',
    model: encodeEvalProfileModel(baseModel, params.profile),
    baseModel,
    authMode: token ? 'web-token' : 'loopback',
    profile: params.profile,
  };
}

function describeAuthMode(env: EvalEnvironment): string {
  return env.authMode === 'web-token'
    ? 'WEB_API_TOKEN injected automatically'
    : 'loopback auth with a dummy API key injected automatically';
}

function normalizeSuiteId(value: string): string {
  return value.trim().toLowerCase().replace(/_/g, '-');
}

function findSuite(value: string): EvalSuiteDefinition | null {
  const normalized = normalizeSuiteId(value);
  if (!normalized) return null;
  for (const suite of EVAL_SUITES) {
    if (suite.id === normalized) return suite;
    if (suite.aliases.some((alias) => normalizeSuiteId(alias) === normalized)) {
      return suite;
    }
  }
  return null;
}

function findSuitePrefixMatches(value: string): EvalSuiteDefinition[] {
  const normalized = normalizeSuiteId(value);
  if (!normalized) return [];
  return EVAL_SUITES.filter((suite) => {
    if (suite.id.startsWith(normalized)) return true;
    return suite.aliases.some((alias) =>
      normalizeSuiteId(alias).startsWith(normalized),
    );
  });
}

function renderSuiteList(): string[] {
  return EVAL_SUITES.map(
    (suite) =>
      `- ${suite.id} — ${suite.summary}${isImplementedManagedSuite(suite) ? '' : ' (not implemented yet)'}`,
  );
}

function isImplementedManagedSuite(suite: EvalSuiteDefinition): boolean {
  return suite.id === 'terminal-bench-2.0';
}

function renderUnimplementedSuite(
  suite: EvalSuiteDefinition,
  env: EvalEnvironment,
): string {
  return [
    suite.summary,
    '',
    'Status:',
    '- Not implemented yet.',
    '',
    'HybridClaw env:',
    `- OPENAI_BASE_URL=${env.baseUrl}`,
    `- OPENAI_API_KEY: ${describeAuthMode(env)}`,
    `- HYBRIDCLAW_EVAL_MODEL=${env.model}`,
    `- Base model: ${env.baseModel}`,
    ...describeEvalProfile(env.profile).map((entry) => `- ${entry}`),
    '',
    'Implemented suites today:',
    '- `/eval terminal-bench-2.0 ...`',
    '- `/eval tau2 ...`',
  ].join('\n');
}

function renderUsage(env: EvalEnvironment): string {
  return [
    "Local eval helper for HybridClaw's OpenAI-compatible gateway.",
    '',
    'Usage:',
    '- `/eval list`',
    '- `/eval env [--current-agent|--fresh-agent] [--ablate-system] [--include-prompt=<parts>] [--omit-prompt=<parts>]`',
    '- `/eval terminal-bench-2.0 [setup|run|status|stop|results|logs]`',
    '- `/eval tau2 [setup|run|status|stop|results]`',
    '- `/eval <suite> [--current-agent|--fresh-agent] [--ablate-system] [--include-prompt=<parts>] [--omit-prompt=<parts>]`',
    '- `/eval [--current-agent|--fresh-agent] [--ablate-system] [--include-prompt=<parts>] [--omit-prompt=<parts>] <shell command...>`',
    '',
    `Base URL: ${env.baseUrl}`,
    `Base model: ${env.baseModel}`,
    `Eval model: ${env.model}`,
    `Auth: ${describeAuthMode(env)}`,
    '',
    'Defaults:',
    ...describeEvalProfile(env.profile).map((entry) => `- ${entry}`),
    '',
    'Suites:',
    ...renderSuiteList(),
    '',
    'Only `terminal-bench-2.0` and `tau2` are implemented today.',
  ].join('\n');
}

function renderKeyValueSection(
  title: string,
  entries: Array<readonly [string, string | number | null | undefined]>,
): string {
  const normalized = entries.filter(
    (entry): entry is readonly [string, string | number] =>
      entry[1] !== null &&
      entry[1] !== undefined &&
      String(entry[1]).trim() !== '',
  );
  if (normalized.length === 0) return '';
  const width = normalized.reduce(
    (max, [label]) => Math.max(max, label.length),
    0,
  );
  const icon = (() => {
    switch (title) {
      case 'Overview':
        return '🧭';
      case 'Results':
        return '📊';
      case 'Progress':
        return '⏳';
      case 'Run':
        return '▶️';
      case 'Paths':
        return '📁';
      case 'Stdout tail':
        return '📄';
      case 'Stderr tail':
        return '⚠️';
      default:
        return '';
    }
  })();
  return renderSectionCard(
    `${icon ? `${icon} ` : ''}${title}`,
    normalized.map(
      ([label, value]) => `${label.padEnd(width)}  ${String(value)}`,
    ),
  );
}

function renderSectionCard(title: string, lines: string[]): string {
  const bodyLines = lines.flatMap((line) =>
    String(line || '')
      .split('\n')
      .map((entry) => entry.trimEnd()),
  );
  const contentWidth = Math.max(
    title.length + 2,
    ...bodyLines.map((line) => line.length),
  );
  const topBorder = `┌─ ${title} ${'─'.repeat(Math.max(1, contentWidth - title.length - 1))}┐`;
  const middle = bodyLines.map((line) => `│ ${line.padEnd(contentWidth)} │`);
  const bottomBorder = `└${'─'.repeat(contentWidth + 2)}┘`;
  return [topBorder, ...middle, bottomBorder].join('\n');
}

function joinSections(sections: Array<string | null | undefined>): string {
  return sections
    .map((section) => String(section || '').trim())
    .filter(Boolean)
    .join('\n\n');
}

function readVersionFromPackageJson(packageJsonPath: string): string | null {
  try {
    const raw = fs.readFileSync(packageJsonPath, 'utf-8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    if (typeof parsed.version === 'string' && parsed.version.trim()) {
      return parsed.version.trim();
    }
  } catch {
    // fall through
  }
  return null;
}

function resolveHarnessVersion(): string {
  if (cachedHarnessVersion) return cachedHarnessVersion;
  const envVersion = process.env.npm_package_version;
  if (envVersion?.trim()) {
    cachedHarnessVersion = envVersion.trim();
    return cachedHarnessVersion;
  }

  const modulePath = fileURLToPath(import.meta.url);
  const moduleVersion = readVersionFromPackageJson(
    path.join(path.dirname(modulePath), '..', '..', 'package.json'),
  );
  if (moduleVersion) {
    cachedHarnessVersion = moduleVersion;
    return cachedHarnessVersion;
  }
  return 'unknown';
}

function renderEnv(env: EvalEnvironment): string {
  return [
    `OPENAI_BASE_URL=${env.baseUrl}`,
    'OPENAI_API_KEY=<injected automatically by `/eval <shell command...>`>',
    `HYBRIDCLAW_EVAL_MODEL=${env.model}`,
    `Base model: ${env.baseModel}`,
    `Auth: ${describeAuthMode(env)}`,
    '',
    ...describeEvalProfile(env.profile),
    '',
    'Use `/eval <shell command...>` to launch a detached benchmark command with those variables in scope.',
  ].join('\n');
}

function renderRecipe(
  suite: EvalSuiteDefinition,
  env: EvalEnvironment,
): string {
  if (!isImplementedManagedSuite(suite)) {
    return renderUnimplementedSuite(suite, env);
  }
  return [
    suite.summary,
    '',
    'HybridClaw env:',
    `- OPENAI_BASE_URL=${env.baseUrl}`,
    `- OPENAI_API_KEY: ${describeAuthMode(env)}`,
    `- HYBRIDCLAW_EVAL_MODEL=${env.model}`,
    `- Base model: ${env.baseModel}`,
    ...describeEvalProfile(env.profile).map((entry) => `- ${entry}`),
    '',
    'Prereqs:',
    ...suite.prereqs.map((entry) => `- ${entry}`),
    '',
    'Starter command:',
    ...suite.starter.map((entry) => `  ${entry}`),
    '',
    'Notes:',
    ...suite.notes.map((entry) => `- ${entry}`),
    '',
    'Managed commands:',
    `- \`/eval ${suite.id} setup\``,
    `- \`/eval ${suite.id} run --num-tasks 10\``,
    `- \`/eval ${suite.id} status\``,
    `- \`/eval ${suite.id} stop\``,
    `- \`/eval ${suite.id} results\``,
    `- \`/eval ${suite.id} logs\``,
    '',
    'Launch the starter or your own command with `/eval <shell command...>`.',
  ].join('\n');
}

function renderTau2Usage(env: EvalEnvironment, dataDir: string): string {
  const installDir = getTau2InstallDir(dataDir);
  return [
    'Managed tau2 benchmark helper for HybridClaw.',
    '',
    'Usage:',
    '- `/eval tau2 setup`',
    '- `/eval tau2 run --domain telecom --num-trials 1 --num-tasks 10`',
    '- `/eval tau2 status`',
    '- `/eval tau2 stop`',
    '- `/eval tau2 results`',
    '',
    `Install dir: ${installDir}`,
    `OPENAI_BASE_URL=${env.baseUrl}`,
    `HYBRIDCLAW_EVAL_MODEL=${env.model}`,
    `Auth: ${describeAuthMode(env)}`,
    '',
    'Defaults:',
    '- Missing `--agent-llm` defaults to `$HYBRIDCLAW_EVAL_MODEL`.',
    '- Missing `--user-llm` defaults to `$HYBRIDCLAW_EVAL_MODEL`.',
    '- TUI and web sessions receive proactive ASCII progress bars when `--num-tasks` is set.',
  ].join('\n');
}

function resolveEvalShell(): { command: string; args: string[] } {
  if (process.platform === 'win32') {
    return {
      command: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c'],
    };
  }
  return {
    command: process.env.SHELL || '/bin/sh',
    args: ['-lc'],
  };
}

function createRunDirectory(dataDir: string): {
  runId: string;
  runDir: string;
  stdoutPath: string;
  stderrPath: string;
  metaPath: string;
} {
  const baseDir = path.join(dataDir, 'evals');
  fs.mkdirSync(baseDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runId = `eval-${timestamp}`;
  const runDir = fs.mkdtempSync(path.join(baseDir, `${runId}-`));
  return {
    runId,
    runDir,
    stdoutPath: path.join(runDir, 'stdout.log'),
    stderrPath: path.join(runDir, 'stderr.log'),
    metaPath: path.join(runDir, 'run.json'),
  };
}

function getEvalBaseDir(dataDir: string): string {
  return path.join(dataDir, 'evals');
}

function getTau2InstallDir(dataDir: string): string {
  return path.join(getEvalBaseDir(dataDir), TAU2_INSTALL_DIRNAME);
}

function getManagedSuiteSetup(
  suite: EvalSuiteDefinition,
): ManagedEvalSuiteSetup | null {
  if (suite.id !== 'terminal-bench-2.0') return null;
  return {
    installDirName: 'terminal-bench-2.0',
    strategyDescription:
      'uv-managed Python 3.12 venv with Hugging Face datasets install and native Terminal-Bench helper smoke test',
  };
}

function getManagedSuiteInstallDir(
  suite: EvalSuiteDefinition,
  dataDir: string,
): string {
  const managed = getManagedSuiteSetup(suite);
  return path.join(
    getEvalBaseDir(dataDir),
    managed?.installDirName || normalizeSuiteId(suite.id),
  );
}

function getManagedSuiteMarkerPath(
  suite: EvalSuiteDefinition,
  dataDir: string,
): string {
  return path.join(
    getManagedSuiteInstallDir(suite, dataDir),
    '.hybridclaw-setup-ok',
  );
}

function getManagedSuitePythonPath(
  suite: EvalSuiteDefinition,
  dataDir: string,
): string {
  const installDir = getManagedSuiteInstallDir(suite, dataDir);
  return process.platform === 'win32'
    ? path.join(installDir, '.venv', 'Scripts', 'python.exe')
    : path.join(installDir, '.venv', 'bin', 'python');
}

function getManagedSuiteExecutablePath(
  suite: EvalSuiteDefinition,
  dataDir: string,
): string | null {
  return suite.id === 'terminal-bench-2.0'
    ? getManagedSuitePythonPath(suite, dataDir)
    : null;
}

function isManagedSuiteInstalled(
  suite: EvalSuiteDefinition,
  dataDir: string,
): boolean {
  return (
    fs.existsSync(getManagedSuiteMarkerPath(suite, dataDir)) &&
    fs.existsSync(getManagedSuitePythonPath(suite, dataDir))
  );
}

function getTau2ExecutablePath(dataDir: string): string {
  const installDir = getTau2InstallDir(dataDir);
  return process.platform === 'win32'
    ? path.join(installDir, '.venv', 'Scripts', 'tau2.exe')
    : path.join(installDir, '.venv', 'bin', 'tau2');
}

function getTau2PythonPath(dataDir: string): string {
  const installDir = getTau2InstallDir(dataDir);
  return process.platform === 'win32'
    ? path.join(installDir, '.venv', 'Scripts', 'python.exe')
    : path.join(installDir, '.venv', 'bin', 'python');
}

function getManagedSuiteSetupCommand(
  suite: EvalSuiteDefinition,
  dataDir: string,
): EvalSetupCommand {
  const managed = getManagedSuiteSetup(suite);
  if (!managed) {
    throw new Error(`No managed setup available for ${suite.id}.`);
  }

  const installDir = getManagedSuiteInstallDir(suite, dataDir);
  const installDirQuoted = quoteShellArg(installDir);
  const markerFile = '.hybridclaw-setup-ok';
  const venvPython =
    process.platform === 'win32'
      ? '.venv\\Scripts\\python.exe'
      : '.venv/bin/python';
  const smokeTest = (() => {
    return `${quoteShellArg(venvPython)} -c "import hybridclaw_terminal_bench_dataset"`;
  })();
  const installStep = (() => {
    return `uv pip install --python ${quoteShellArg(venvPython)} datasets`;
  })();
  const fallbackInstallStep = (() => {
    return 'python -m pip install datasets';
  })();
  const repoSyncStep = (() => {
    return process.platform === 'win32'
      ? `if not exist ${installDirQuoted} mkdir ${installDirQuoted}`
      : `mkdir -p ${installDirQuoted}`;
  })();
  const cdStep =
    process.platform === 'win32'
      ? `cd /d ${installDirQuoted}`
      : `cd ${installDirQuoted}`;
  const markerStep =
    process.platform === 'win32'
      ? `type nul > ${quoteShellArg(markerFile)}`
      : `touch ${quoteShellArg(markerFile)}`;

  if (hasUvAvailable()) {
    return {
      strategy: 'uv',
      command: [
        repoSyncStep,
        cdStep,
        'uv venv --seed --clear --managed-python --python 3.12 .venv',
        installStep,
        smokeTest,
        markerStep,
      ].join(' && '),
    };
  }

  const fallbackCommand =
    process.platform === 'win32'
      ? [
          repoSyncStep,
          cdStep,
          'py -m venv .venv',
          'call .venv\\Scripts\\activate',
          'python -m pip install --upgrade pip',
          fallbackInstallStep,
          smokeTest,
          markerStep,
        ].join(' && ')
      : [
          repoSyncStep,
          cdStep,
          'python3 -m venv .venv',
          '. .venv/bin/activate',
          'python -m pip install --upgrade pip',
          fallbackInstallStep,
          smokeTest,
          markerStep,
        ].join(' && ');

  return {
    strategy: 'system-python',
    command: fallbackCommand,
  };
}

function getManagedSuiteNextStep(
  suite: EvalSuiteDefinition,
  _dataDir: string,
): string {
  switch (suite.id) {
    case 'terminal-bench-2.0': {
      return `/eval terminal-bench-2.0 run --num-tasks 10`;
    }
    default:
      return `/eval ${suite.id}`;
  }
}

function getTerminalBenchDatasetHelperPath(dataDir: string): string {
  return path.join(
    getEvalBaseDir(dataDir),
    'terminal-bench-2.0',
    'hybridclaw_terminal_bench_dataset.py',
  );
}

function ensureTerminalBenchDatasetHelper(dataDir: string): void {
  const helperPath = getTerminalBenchDatasetHelperPath(dataDir);
  fs.mkdirSync(path.dirname(helperPath), { recursive: true });
  const content = [
    'import argparse',
    'import json',
    '',
    'from datasets import load_dataset',
    '',
    '',
    'def main() -> None:',
    "    parser = argparse.ArgumentParser(description='HybridClaw Terminal-Bench dataset helper')",
    "    subparsers = parser.add_subparsers(dest='command', required=True)",
    "    list_parser = subparsers.add_parser('list')",
    "    list_parser.add_argument('--num-tasks', type=int, default=1)",
    "    list_parser.add_argument('--task-filter', default='')",
    "    list_parser.add_argument('--dataset', default='NousResearch/terminal-bench-2')",
    '    args = parser.parse_args()',
    '',
    "    ds = load_dataset(args.dataset, split='train')",
    '    tasks = list(ds)',
    '    filters = [entry.strip() for entry in str(args.task_filter or "").split(",") if entry.strip()]',
    '    if filters:',
    '        allowed = set(filters)',
    '        tasks = [task for task in tasks if str(task.get("task_name", "")).strip() in allowed]',
    '    tasks = tasks[: max(1, int(args.num_tasks or 1))]',
    '    payload = []',
    '    for task in tasks:',
    '        payload.append({',
    '            "task_name": task.get("task_name", ""),',
    '            "category": task.get("category", "unknown"),',
    '            "instruction": task.get("instruction", ""),',
    '            "docker_image": task.get("docker_image", ""),',
    '            "environment_tar": task.get("environment_tar", ""),',
    '            "tests_tar": task.get("tests_tar", ""),',
    '            "test_sh": task.get("test_sh", ""),',
    '        })',
    '    print(json.dumps(payload))',
    '',
    '',
    'if __name__ == "__main__":',
    '    main()',
    '',
  ].join('\n');
  fs.writeFileSync(helperPath, content, 'utf-8');
}

function prepareManagedSuiteRun(
  suite: EvalSuiteDefinition,
  dataDir: string,
  env: EvalEnvironment,
  effectiveAgentId: string,
  args: string[],
): ManagedSuiteRunPreparation | null {
  if (suite.id !== 'terminal-bench-2.0') return null;
  ensureTerminalBenchDatasetHelper(dataDir);

  const translatedArgs: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const current = String(args[index] || '').trim();
    if (!current) continue;
    if (current === '--num-tasks') {
      const next = String(args[index + 1] || '').trim();
      if (next) translatedArgs.push('--num-tasks', next);
      index += 1;
      continue;
    }
    if (current.startsWith('--num-tasks=')) {
      const value = current.slice('--num-tasks='.length).trim();
      if (value) translatedArgs.push('--num-tasks', value);
      continue;
    }
    translatedArgs.push(current === '-n' ? '--n-concurrent' : current);
  }

  if (
    !hasCommandOption(translatedArgs, '--n-concurrent') &&
    !hasCommandOption(translatedArgs, '-n')
  ) {
    const defaultConcurrency = isContainerMaxConcurrentExplicit()
      ? Math.max(1, Math.min(MAX_CONCURRENT_CONTAINERS - 1, 4))
      : 1;
    translatedArgs.push('--n-concurrent', String(defaultConcurrency));
  }

  const cliEntry = process.argv[1]?.trim();
  if (!cliEntry) return null;
  const promptMode = 'none';
  const internalArgs = [
    quoteShellArg(process.execPath),
    quoteShellArg(path.resolve(cliEntry)),
    '__eval-terminal-bench-native',
    '--install-dir',
    quoteShellArg(getManagedSuiteInstallDir(suite, dataDir)),
    '--data-dir',
    quoteShellArg(dataDir),
    '--agent-id',
    quoteShellArg(effectiveAgentId || 'main'),
    '--model',
    quoteShellArg(env.baseModel),
    '--prompt-mode',
    quoteShellArg(promptMode),
    ...translatedArgs,
  ];
  if (env.profile.includePromptParts.length > 0) {
    internalArgs.push(
      '--include-prompt',
      quoteShellArg(env.profile.includePromptParts.join(',')),
    );
  }
  if (env.profile.omitPromptParts.length > 0) {
    internalArgs.push(
      '--omit-prompt',
      quoteShellArg(env.profile.omitPromptParts.join(',')),
    );
  }

  return {
    commandArgs: ['terminal-bench-2.0', 'run', ...translatedArgs],
    command: buildCommandString(internalArgs),
    displayCommand: buildCommandString([suite.id, 'run', ...args]),
    cwd: dataDir,
  };
}

function quoteShellArg(value: string): string {
  if (process.platform === 'win32') {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function tailLines(text: string, maxLines: number): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
  if (lines.length <= maxLines) return lines.join('\n');
  return lines.slice(-maxLines).join('\n');
}

function firstMeaningfulLogLine(text: string): string | null {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return null;
  const preferred =
    lines.find((line) => /^error[:\s]/i.test(line)) ||
    lines.find((line) => /^fatal[:\s]/i.test(line)) ||
    lines[lines.length - 1];
  return preferred || null;
}

function describeRunFailureReason(meta: EvalRunMeta): string | null {
  if (readRunMetaStatus(meta) !== 'exited') return null;
  const stderrSummary = firstMeaningfulLogLine(
    readLogFileText(meta.stderrPath),
  );
  if (stderrSummary) return stderrSummary;
  const stdoutSummary = firstMeaningfulLogLine(
    readLogFileText(meta.stdoutPath),
  );
  return stdoutSummary;
}

function parseIsoDate(value: string | null | undefined): number {
  const timestamp = Date.parse(String(value || '').trim());
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function sanitizeEvalTaskName(value: string): string {
  return String(value || '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function formatIntegerValue(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

function formatTerminalBenchTokenUsage(
  tokenUsage: TerminalBenchNativeTokenUsage | null | undefined,
): string | null {
  if (!tokenUsage) return null;
  if (tokenUsage.apiUsageAvailable && tokenUsage.apiTotalTokens > 0) {
    return `${formatIntegerValue(tokenUsage.apiTotalTokens)} total (${formatIntegerValue(tokenUsage.apiPromptTokens)} prompt / ${formatIntegerValue(tokenUsage.apiCompletionTokens)} completion)`;
  }
  if (tokenUsage.estimatedTotalTokens > 0) {
    return `${formatIntegerValue(tokenUsage.estimatedTotalTokens)} estimated (${formatIntegerValue(tokenUsage.estimatedPromptTokens)} prompt / ${formatIntegerValue(tokenUsage.estimatedCompletionTokens)} completion)`;
  }
  return null;
}

function listEvalRunMetas(dataDir: string): EvalRunMeta[] {
  const baseDir = getEvalBaseDir(dataDir);
  if (!fs.existsSync(baseDir)) return [];
  const metas: EvalRunMeta[] = [];
  for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const metaPath = path.join(baseDir, entry.name, 'run.json');
    if (!fs.existsSync(metaPath)) continue;
    try {
      const raw = fs.readFileSync(metaPath, 'utf-8');
      metas.push(JSON.parse(raw) as EvalRunMeta);
    } catch {
      // ignore malformed eval metadata
    }
  }
  metas.sort(
    (left, right) =>
      parseIsoDate(right.startedAt) - parseIsoDate(left.startedAt),
  );
  return metas;
}

function findEvalRunMetaPath(dataDir: string, runId: string): string | null {
  const baseDir = getEvalBaseDir(dataDir);
  if (!fs.existsSync(baseDir)) return null;
  for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (!entry.name.startsWith(`${runId}-`)) continue;
    const metaPath = path.join(baseDir, entry.name, 'run.json');
    if (fs.existsSync(metaPath)) return metaPath;
  }
  return null;
}

function isRunMetaActive(meta: EvalRunMeta): boolean {
  if (meta.finishedAt) return false;
  return isProcessRunning(meta.pid);
}

function readRunMetaStatus(meta: EvalRunMeta): 'running' | 'exited' {
  return isRunMetaActive(meta) ? 'running' : 'exited';
}

function findLatestEvalRun(
  dataDir: string,
  predicate: (meta: EvalRunMeta) => boolean,
): EvalRunMeta | null {
  return listEvalRunMetas(dataDir).find(predicate) || null;
}

function isTau2RunMeta(
  meta: EvalRunMeta,
  operation?: 'setup' | 'run',
): boolean {
  if (meta.suiteId !== 'tau2') return false;
  if (!operation) return true;
  return meta.operation === operation;
}

function getTau2SetupCommand(dataDir: string): string {
  const installDir = getTau2InstallDir(dataDir);
  const installDirQuoted = quoteShellArg(installDir);
  const repoUrlQuoted = quoteShellArg(TAU2_REPO_URL);
  if (process.platform === 'win32') {
    return [
      `if exist ${quoteShellArg(path.join(installDir, '.git'))} (git -C ${installDirQuoted} pull --ff-only) else (git clone ${repoUrlQuoted} ${installDirQuoted})`,
      `cd /d ${installDirQuoted}`,
      'py -m venv .venv',
      'call .venv\\Scripts\\activate',
      'python -m pip install --upgrade pip',
      'python -m pip install -e .',
      '.venv\\Scripts\\python.exe -c "import tau2.cli"',
    ].join(' && ');
  }
  return [
    `if [ -d ${quoteShellArg(path.join(installDir, '.git'))} ]; then git -C ${installDirQuoted} pull --ff-only; else git clone ${repoUrlQuoted} ${installDirQuoted}; fi`,
    `cd ${installDirQuoted}`,
    'python3 -m venv .venv',
    '. .venv/bin/activate',
    'python -m pip install --upgrade pip',
    'python -m pip install -e .',
    '.venv/bin/python -c "import tau2.cli"',
  ].join(' && ');
}

function hasUvAvailable(): boolean {
  try {
    const result = spawnSync('uv', ['--version'], {
      stdio: 'ignore',
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

function getTau2SetupSpec(dataDir: string): EvalSetupCommand {
  const installDir = getTau2InstallDir(dataDir);
  const installDirQuoted = quoteShellArg(installDir);
  const repoUrlQuoted = quoteShellArg(TAU2_REPO_URL);
  const smokeTest =
    process.platform === 'win32'
      ? `${quoteShellArg('.venv\\Scripts\\python.exe')} -c "import tau2.cli"`
      : `${quoteShellArg('.venv/bin/python')} -c "import tau2.cli"`;

  if (hasUvAvailable()) {
    const venvPath =
      process.platform === 'win32'
        ? '.venv\\Scripts\\python.exe'
        : '.venv/bin/python';
    return {
      strategy: 'uv',
      command: [
        process.platform === 'win32'
          ? `if exist ${quoteShellArg(path.join(installDir, '.git'))} (git -C ${installDirQuoted} pull --ff-only) else (git clone ${repoUrlQuoted} ${installDirQuoted})`
          : `if [ -d ${quoteShellArg(path.join(installDir, '.git'))} ]; then git -C ${installDirQuoted} pull --ff-only; else git clone ${repoUrlQuoted} ${installDirQuoted}; fi`,
        process.platform === 'win32'
          ? `cd /d ${installDirQuoted}`
          : `cd ${installDirQuoted}`,
        'uv venv --seed --clear --managed-python --python 3.12 .venv',
        `uv pip install --python ${quoteShellArg(venvPath)} -e .`,
        smokeTest,
      ].join(' && '),
    };
  }

  return {
    strategy: 'system-python',
    command: getTau2SetupCommand(dataDir),
  };
}

function isTau2Installed(dataDir: string): boolean {
  return (
    fs.existsSync(path.join(getTau2InstallDir(dataDir), '.git')) &&
    fs.existsSync(getTau2ExecutablePath(dataDir)) &&
    fs.existsSync(getTau2PythonPath(dataDir))
  );
}

function formatRunProgress(meta: EvalRunMeta): string | null {
  if (!meta.progress?.total) return null;
  return `${meta.progress.label} ${meta.progress.completed}/${meta.progress.total} ${meta.progress.unit}`;
}

function parseTau2RunSummary(stdoutText: string): Tau2RunSummary | null {
  const totalTasksMatch = stdoutText.match(/Total Tasks[^\r\n]*?(\d+)/i);
  const totalSimulationsMatch = stdoutText.match(
    /Total Simulations[^\r\n]*?(\d+)/i,
  );
  const averageRewardMatch = stdoutText.match(
    /Average Reward[^\r\n]*?([0-9]+\.[0-9]+)/i,
  );
  const passRateMatch = stdoutText.match(/Pass\^?1?[^\r\n]*?([0-9]+\.[0-9]+)/i);
  const dbMatch = stdoutText.match(
    /DB Match[^\r\n]*?(\d+)\s*\/\s*[^\d\r\n]*(\d+)\s*\(([\d.]+)%\)/i,
  );
  if (!dbMatch) return null;

  const totalTasks = parseNonNegativeInteger(totalTasksMatch?.[1] || null);
  const totalSimulations = parseNonNegativeInteger(
    totalSimulationsMatch?.[1] || null,
  );
  const averageReward = String(averageRewardMatch?.[1] || '').trim() || null;
  const passRate = String(passRateMatch?.[1] || '').trim() || null;
  const dbMatched = parseNonNegativeInteger(dbMatch[1] || null);
  const dbMismatched = parseNonNegativeInteger(dbMatch[2] || null);
  const dbMatchPercent = String(dbMatch[3] || '').trim();
  if (dbMatched == null || dbMismatched == null || !dbMatchPercent) {
    return null;
  }

  const normalStopMatch = stdoutText.match(/Normal Stop[^\r\n]*?(\d+)/i);
  const normalStop = parseNonNegativeInteger(normalStopMatch?.[1] || null);
  const rewardBasis = totalTasks ?? totalSimulations;
  const rewardPassed =
    passRate && rewardBasis != null
      ? Math.round(Number.parseFloat(passRate) * rewardBasis)
      : null;

  return {
    totalTasks,
    totalSimulations,
    averageReward,
    passRate,
    rewardPassed,
    dbMatched,
    dbMismatched,
    dbTotal: dbMatched + dbMismatched,
    dbMatchPercent,
    normalStop,
  };
}

function readTau2RunSummary(meta: EvalRunMeta): Tau2RunSummary | null {
  if (meta.suiteId !== 'tau2' || meta.operation !== 'run') return null;
  return parseTau2RunSummary(readLogFileText(meta.stdoutPath));
}

function readTerminalBenchJobDir(meta: EvalRunMeta): string | null {
  if (meta.suiteId !== 'terminal-bench-2.0' || meta.operation !== 'run') {
    return null;
  }
  const stdoutText = readLogFileText(meta.stdoutPath);
  const match = stdoutText.match(/^Job dir:\s*(.+)$/m);
  const jobDir = String(match?.[1] || '').trim();
  return jobDir ? jobDir : null;
}

function readFiniteTokenNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function readTerminalBenchJobTokenUsage(
  jobDir: string,
  taskNames?: readonly string[],
): TerminalBenchNativeTokenUsage | null {
  const taskDirs =
    Array.isArray(taskNames) && taskNames.length > 0
      ? [
          ...new Set(
            taskNames.map((taskName) => sanitizeEvalTaskName(taskName)),
          ),
        ]
      : fs
          .readdirSync(jobDir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name);
  const totals: TerminalBenchNativeTokenUsage = {
    modelCalls: 0,
    apiPromptTokens: 0,
    apiCompletionTokens: 0,
    apiTotalTokens: 0,
    estimatedPromptTokens: 0,
    estimatedCompletionTokens: 0,
    estimatedTotalTokens: 0,
    apiUsageAvailable: false,
  };
  let foundAny = false;

  for (const taskDirName of taskDirs) {
    const agentResultPath = path.join(jobDir, taskDirName, 'agent-result.json');
    if (!fs.existsSync(agentResultPath)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(agentResultPath, 'utf-8')) as {
        tokenUsage?: Record<string, unknown>;
      };
      const tokenUsage = parsed.tokenUsage;
      if (!tokenUsage || typeof tokenUsage !== 'object') continue;
      foundAny = true;
      totals.modelCalls += readFiniteTokenNumber(tokenUsage.modelCalls);
      totals.apiPromptTokens += readFiniteTokenNumber(
        tokenUsage.apiPromptTokens,
      );
      totals.apiCompletionTokens += readFiniteTokenNumber(
        tokenUsage.apiCompletionTokens,
      );
      totals.apiTotalTokens += readFiniteTokenNumber(tokenUsage.apiTotalTokens);
      totals.estimatedPromptTokens += readFiniteTokenNumber(
        tokenUsage.estimatedPromptTokens,
      );
      totals.estimatedCompletionTokens += readFiniteTokenNumber(
        tokenUsage.estimatedCompletionTokens,
      );
      totals.estimatedTotalTokens += readFiniteTokenNumber(
        tokenUsage.estimatedTotalTokens,
      );
      if (tokenUsage.apiUsageAvailable === true) {
        totals.apiUsageAvailable = true;
      }
    } catch {
      // ignore malformed per-task agent results
    }
  }

  return foundAny ? totals : null;
}

function readTerminalBenchNativeSummary(
  meta: EvalRunMeta,
): TerminalBenchNativeSummary | null {
  const jobDir = readTerminalBenchJobDir(meta);
  if (!jobDir) return null;
  const resultPath = path.join(jobDir, 'result.json');
  if (!fs.existsSync(resultPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(resultPath, 'utf-8')) as {
      agent?: string;
      dataset?: string;
      trials?: number;
      errors?: number;
      mean?: number;
      rewards?: TerminalBenchNativeReward[];
    };
    const rewards = Array.isArray(parsed.rewards) ? parsed.rewards : [];
    const passed = rewards.filter((reward) => reward.passed === true).length;
    const failedWithError = rewards.filter(
      (reward) => reward.passed !== true && Boolean(reward.error),
    ).length;
    return {
      jobDir,
      resultPath,
      agent: typeof parsed.agent === 'string' ? parsed.agent : null,
      dataset: typeof parsed.dataset === 'string' ? parsed.dataset : null,
      trials:
        typeof parsed.trials === 'number' && Number.isFinite(parsed.trials)
          ? parsed.trials
          : rewards.length,
      errors: rewards.length > 0 ? failedWithError : 0,
      mean:
        typeof parsed.mean === 'number' && Number.isFinite(parsed.mean)
          ? parsed.mean
          : 0,
      passed,
      rewards,
      tokenUsage: readTerminalBenchJobTokenUsage(
        jobDir,
        rewards
          .map((reward) => reward.taskName)
          .filter(
            (taskName): taskName is string => typeof taskName === 'string',
          ),
      ),
    };
  } catch {
    return null;
  }
}

function readTerminalBenchNativeProgress(
  meta: EvalRunMeta,
): TerminalBenchNativeProgress | null {
  const jobDir = readTerminalBenchJobDir(meta);
  if (!jobDir) return null;
  const stdoutText = readLogFileText(meta.stdoutPath);
  if (!stdoutText.trim()) return null;

  const totalTasksMatch = stdoutText.match(/^Tasks:\s*(\d+)\s*$/m);
  const totalTasks = parsePositiveInteger(totalTasksMatch?.[1] || null);
  const started = [...stdoutText.matchAll(/^\[(\d+)\/(\d+)\]\s+START\s+/gm)]
    .length;
  const passCount = [...stdoutText.matchAll(/^\[(\d+)\/(\d+)\]\s+PASS\s+/gm)]
    .length;
  const failCount = [...stdoutText.matchAll(/^\[(\d+)\/(\d+)\]\s+FAIL\s+/gm)]
    .length;
  const errorCount = [...stdoutText.matchAll(/^\[(\d+)\/(\d+)\]\s+ERROR\s+/gm)]
    .length;
  const finished = passCount + failCount + errorCount;
  const running = Math.max(0, started - finished);
  const pending = totalTasks != null ? Math.max(0, totalTasks - started) : null;

  if (
    totalTasks == null &&
    started === 0 &&
    finished === 0 &&
    running === 0 &&
    pending == null
  ) {
    return null;
  }

  return {
    jobDir,
    totalTasks,
    started,
    finished,
    passed: passCount,
    failed: failCount + errorCount,
    running,
    pending,
    tokenUsage: readTerminalBenchJobTokenUsage(jobDir),
  };
}

function describeManagedSuiteRunLifecycle(
  meta: EvalRunMeta,
  summary?: TerminalBenchNativeSummary | null,
): string {
  if (isRunMetaActive(meta)) return 'running';
  if (meta.exitSignal === 'SIGTERM') return 'stopped';
  if (summary && (meta.exitCode ?? 0) === 0) return 'completed';
  if ((meta.exitCode ?? 0) === 0) return 'completed';
  return 'failed';
}

function formatTau2SuccessLine(summary: Tau2RunSummary): string {
  if (summary.rewardPassed != null) {
    const rewardTotal =
      summary.totalTasks ?? summary.totalSimulations ?? summary.dbTotal;
    return `Success: ${summary.rewardPassed}/${rewardTotal} (${summary.passRate} reward pass)`;
  }
  if (summary.averageReward) {
    return `Success: average reward ${summary.averageReward}`;
  }
  return `Success: ${summary.dbMatched}/${summary.dbTotal} (${summary.dbMatchPercent}% DB match)`;
}

function formatTau2DbMatchLine(summary: Tau2RunSummary): string {
  return `DB match: ${summary.dbMatched}/${summary.dbTotal} (${summary.dbMatchPercent}%)`;
}

function formatTau2ConversationLine(summary: Tau2RunSummary): string | null {
  if (summary.normalStop == null) return null;
  return `Conversations: ${summary.normalStop} normal stop`;
}

function extractTau2MetricsSection(stdoutText: string): string | null {
  const lines = stdoutText.split(/\r?\n/).map((line) => line.trimEnd());
  const startIndex = lines.findIndex((line) =>
    line.includes('Agent Performance Metrics'),
  );
  if (startIndex < 0) return null;
  const endIndex = lines.findIndex(
    (line, index) => index > startIndex && line.startsWith('╰'),
  );
  const slice =
    endIndex >= 0
      ? lines.slice(startIndex, endIndex + 1)
      : lines.slice(startIndex, startIndex + 40);
  const block = slice.join('\n').trim();
  return block || null;
}

function killDetachedProcess(pid: number | null): boolean {
  if (!pid || pid <= 0) return false;
  try {
    if (process.platform !== 'win32') {
      try {
        process.kill(-pid, 'SIGTERM');
        return true;
      } catch {
        // fall through to direct pid signal
      }
    }
    process.kill(pid, 'SIGTERM');
    return true;
  } catch {
    return false;
  }
}

function hasCommandOption(commandArgs: string[], option: string): boolean {
  for (let index = 0; index < commandArgs.length; index += 1) {
    const current = String(commandArgs[index] || '').trim();
    if (!current) continue;
    if (current === option || current.startsWith(`${option}=`)) {
      return true;
    }
  }
  return false;
}

function readCommandOptionValue(
  commandArgs: string[],
  option: string,
): string | null {
  for (let index = 0; index < commandArgs.length; index += 1) {
    const current = String(commandArgs[index] || '').trim();
    if (!current) continue;
    if (current === option) {
      const next = String(commandArgs[index + 1] || '').trim();
      return next || null;
    }
    if (current.startsWith(`${option}=`)) {
      return current.slice(option.length + 1).trim() || null;
    }
  }
  return null;
}

function parsePositiveInteger(value: string | null): number | null {
  const parsed = Number.parseInt(String(value || '').trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseNonNegativeInteger(value: string | null): number | null {
  const parsed = Number.parseInt(String(value || '').trim(), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function buildCommandString(commandArgs: string[]): string {
  return commandArgs.join(' ').trim();
}

function prepareEvalRun(commandArgs: string[]): EvalRunPreparation {
  const normalizedArgs = [...commandArgs];
  const isTau2Run =
    String(normalizedArgs[0] || '')
      .trim()
      .toLowerCase() === 'tau2' &&
    String(normalizedArgs[1] || '')
      .trim()
      .toLowerCase() === 'run';

  let progress: EvalProgressSpec | null = null;
  if (isTau2Run) {
    if (!hasCommandOption(normalizedArgs, '--agent-llm')) {
      normalizedArgs.push('--agent-llm', '"$HYBRIDCLAW_EVAL_MODEL"');
    }
    if (!hasCommandOption(normalizedArgs, '--user-llm')) {
      normalizedArgs.push('--user-llm', '"$HYBRIDCLAW_EVAL_MODEL"');
    }
    progress = {
      kind: 'tau2',
      label: 'tau2',
      total: parsePositiveInteger(
        readCommandOptionValue(normalizedArgs, '--num-tasks'),
      ),
      unit: 'tasks',
    };
  }

  return {
    commandArgs: normalizedArgs,
    command: buildCommandString(normalizedArgs),
    progress,
  };
}

function readLogFileText(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return '';
  }
}

function clampProgress(value: number, total: number | null): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (total && total > 0) {
    return Math.min(total, Math.max(0, Math.floor(value)));
  }
  return Math.max(0, Math.floor(value));
}

function extractTau2CompletedTasks(params: {
  stdoutText: string;
  stderrText: string;
  total: number | null;
}): number {
  const haystacks = [params.stdoutText, params.stderrText];
  let maxCompleted = 0;

  const updateMax = (value: number): void => {
    maxCompleted = Math.max(maxCompleted, clampProgress(value, params.total));
  };

  for (const haystack of haystacks) {
    if (!haystack) continue;

    for (const match of haystack.matchAll(
      /\btask\s+(\d+)\s*(?:\/|of)\s*(\d+)\b/gi,
    )) {
      const current = parsePositiveInteger(match[1] || null);
      const total = parsePositiveInteger(match[2] || null);
      if (!current) continue;
      if (params.total && total && total !== params.total) continue;
      updateMax(current);
    }

    for (const match of haystack.matchAll(
      /\b(?:running|starting|processing|completed|finished)\s+task\s+(\d+)\b/gi,
    )) {
      const current = parsePositiveInteger(match[1] || null);
      if (current) updateMax(current);
    }
  }

  return maxCompleted;
}

function isProcessRunning(pid: number | null): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function formatProgressBar(completed: number, total: number): string {
  const safeTotal = Math.max(1, total);
  const ratio = Math.max(0, Math.min(1, completed / safeTotal));
  const filled = Math.round(ratio * EVAL_PROGRESS_BAR_WIDTH);
  return `[${'#'.repeat(filled)}${'-'.repeat(
    EVAL_PROGRESS_BAR_WIDTH - filled,
  )}]`;
}

function formatProgressMessage(params: {
  runId: string;
  label: string;
  completed: number;
  total: number;
  unit: string;
  status?: 'running' | 'exited';
}): string {
  const statusPrefix = params.status === 'exited' ? 'finished' : 'progress';
  return `Eval ${statusPrefix} ${params.runId}: ${params.label} ${formatProgressBar(
    params.completed,
    params.total,
  )} ${params.completed}/${params.total} ${params.unit}`;
}

function enqueueEvalProgressMessage(
  channelId: string | undefined,
  text: string,
): void {
  const normalizedChannelId = String(channelId || '').trim();
  if (!normalizedChannelId || !text.trim() || !isDatabaseInitialized()) return;
  enqueueProactiveMessage(
    normalizedChannelId,
    text.trim(),
    'eval',
    MAX_QUEUED_EVAL_MESSAGES,
  );
}

function supportsQueuedEvalProgress(channelId: string | undefined): boolean {
  const normalizedChannelId = String(channelId || '')
    .trim()
    .toLowerCase();
  return normalizedChannelId === 'tui' || normalizedChannelId === 'web';
}

function buildTau2ExitNotification(meta: EvalRunMeta): string | null {
  if (meta.suiteId !== 'tau2') return null;
  const status = readRunMetaStatus(meta);
  if (status !== 'exited') return null;
  const failed =
    (meta.exitCode ?? 0) !== 0 ||
    (typeof meta.exitSignal === 'string' && meta.exitSignal.length > 0);
  const progressSummary = formatRunProgress(meta);
  const summary = readTau2RunSummary(meta);

  if (meta.operation === 'setup' && !failed) {
    return [
      `tau2 setup completed successfully.`,
      '',
      `Run ID: ${meta.runId}`,
      'Next: `/eval tau2 run --domain telecom --num-trials 1 --num-tasks 10`',
    ].join('\n');
  }
  if (meta.operation === 'setup') {
    const reason = describeRunFailureReason(meta);
    return [
      `tau2 setup failed.`,
      '',
      `Run ID: ${meta.runId}`,
      ...(reason ? [`Reason: ${reason}`] : []),
      'Use `/eval tau2 results` for the setup logs.',
    ].join('\n');
  }

  if (meta.operation === 'run' && !failed) {
    return [
      `tau2 run completed.`,
      '',
      `Run ID: ${meta.runId}`,
      ...(summary ? [formatTau2SuccessLine(summary)] : []),
      ...(summary ? [formatTau2DbMatchLine(summary)] : []),
      ...(summary
        ? (() => {
            const conversationLine = formatTau2ConversationLine(summary);
            return conversationLine ? [conversationLine] : [];
          })()
        : progressSummary
          ? [`Progress: ${progressSummary}`]
          : []),
      'Use `/eval tau2 results` for the run logs.',
    ].join('\n');
  }

  if (meta.operation === 'run') {
    const reason = describeRunFailureReason(meta);
    return [
      `tau2 run failed.`,
      '',
      `Run ID: ${meta.runId}`,
      ...(summary ? [formatTau2SuccessLine(summary)] : []),
      ...(summary ? [formatTau2DbMatchLine(summary)] : []),
      ...(summary
        ? (() => {
            const conversationLine = formatTau2ConversationLine(summary);
            return conversationLine ? [conversationLine] : [];
          })()
        : progressSummary
          ? [`Progress: ${progressSummary}`]
          : []),
      ...(reason ? [`Reason: ${reason}`] : []),
      'Use `/eval tau2 results` for the run logs.',
    ].join('\n');
  }

  return null;
}

function buildManagedSuiteSetupExitNotification(
  meta: EvalRunMeta,
  dataDir: string,
): string | null {
  if (meta.suiteId === 'tau2' || !meta.suiteId) {
    return null;
  }
  const suite = findSuite(meta.suiteId);
  const managed = suite ? getManagedSuiteSetup(suite) : null;
  if (!suite || !managed || readRunMetaStatus(meta) !== 'exited') return null;
  const failed =
    (meta.exitCode ?? 0) !== 0 ||
    (typeof meta.exitSignal === 'string' && meta.exitSignal.length > 0);
  if (meta.operation === 'setup') {
    if (!failed) {
      return [
        `${suite.title} setup completed successfully.`,
        '',
        `Run ID: ${meta.runId}`,
        `Install dir: ${getManagedSuiteInstallDir(suite, dataDir)}`,
        `Next: \`${getManagedSuiteNextStep(suite, dataDir)}\``,
      ].join('\n');
    }
    const reason = describeRunFailureReason(meta);
    return [
      `${suite.title} setup failed.`,
      '',
      `Run ID: ${meta.runId}`,
      ...(reason ? [`Reason: ${reason}`] : []),
      `Use \`/eval ${suite.id} logs\` for the setup logs.`,
    ].join('\n');
  }
  if (meta.operation === 'run') {
    const reason = describeRunFailureReason(meta);
    if (!failed) {
      return [
        `${suite.title} run completed.`,
        '',
        `Run ID: ${meta.runId}`,
        `Use \`/eval ${suite.id} results\` for the summary.`,
        `Use \`/eval ${suite.id} logs\` for the run logs.`,
      ].join('\n');
    }
    return [
      `${suite.title} run failed.`,
      '',
      `Run ID: ${meta.runId}`,
      ...(reason ? [`Reason: ${reason}`] : []),
      `Use \`/eval ${suite.id} results\` for the summary.`,
      `Use \`/eval ${suite.id} logs\` for the run logs.`,
    ].join('\n');
  }
  return null;
}

function shouldEmitExitProgressMessage(progress: EvalProgressSpec): boolean {
  return progress.kind !== 'tau2';
}

function writeRunMeta(metaPath: string, meta: EvalRunMeta): void {
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
}

async function waitForImmediateExit(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null } | null> {
  if (timeoutMs <= 0 || typeof child.on !== 'function') return null;

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve(null);
    }, timeoutMs);
    timer.unref?.();

    const handleExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      resolve({ code, signal });
    };

    const cleanup = () => {
      clearTimeout(timer);
      if (typeof child.off === 'function') {
        child.off('exit', handleExit);
      }
    };

    child.on('exit', handleExit);
  });
}

function startEvalProgressTracker(params: {
  channelId?: string;
  runId: string;
  pid: number | null;
  metaPath: string;
  stdoutPath: string;
  stderrPath: string;
  progress: EvalProgressSpec | null;
}): void {
  const progress = params.progress;
  if (
    !progress ||
    !progress.total ||
    progress.total <= 0 ||
    !supportsQueuedEvalProgress(params.channelId)
  ) {
    return;
  }
  const total = progress.total;

  let lastReportedCompleted = -1;

  const report = (completed: number, status: 'running' | 'exited'): void => {
    const normalizedCompleted = clampProgress(completed, progress.total);
    if (status === 'running' && normalizedCompleted <= lastReportedCompleted) {
      return;
    }
    lastReportedCompleted = Math.max(
      lastReportedCompleted,
      normalizedCompleted,
    );
    enqueueEvalProgressMessage(
      params.channelId,
      formatProgressMessage({
        runId: params.runId,
        label: progress.label,
        completed: normalizedCompleted,
        total,
        unit: progress.unit,
        status,
      }),
    );
  };

  const updateMeta = (
    completed: number,
    status: 'running' | 'exited',
  ): void => {
    try {
      const raw = fs.readFileSync(params.metaPath, 'utf-8');
      const meta = JSON.parse(raw) as EvalRunMeta;
      meta.progress = {
        kind: progress.kind,
        label: progress.label,
        unit: progress.unit,
        total,
        completed: clampProgress(completed, total),
        status,
        updatedAt: new Date().toISOString(),
      };
      writeRunMeta(params.metaPath, meta);
    } catch {
      // best effort only
    }
  };

  const poll = (): void => {
    const stdoutText = readLogFileText(params.stdoutPath);
    const stderrText = readLogFileText(params.stderrPath);
    const completed = extractTau2CompletedTasks({
      stdoutText,
      stderrText,
      total,
    });
    const running = isProcessRunning(params.pid);
    updateMeta(completed, running ? 'running' : 'exited');
    if (running) {
      report(completed, 'running');
    } else if (shouldEmitExitProgressMessage(progress)) {
      report(completed, 'exited');
    }
    if (!running) {
      clearInterval(interval);
    }
  };

  report(0, 'running');
  updateMeta(0, 'running');
  const interval = setInterval(poll, EVAL_PROGRESS_POLL_INTERVAL_MS);
  interval.unref();
}

async function startDetachedEvalRun(params: {
  command: string;
  commandArgs: string[];
  dataDir: string;
  env: EvalEnvironment;
  channelId?: string;
  cwd?: string;
  suiteId?: string;
  operation?: string;
  displayCommand?: string;
  title?: string;
  footerLines?: string[];
  earlyExitCheckMs?: number;
  dataDirForNotifications?: string;
}): Promise<GatewayCommandResult> {
  const prepared = prepareEvalRun(params.commandArgs);
  const shellCommand = String(params.command || '').trim() || prepared.command;
  const { runId, runDir, stdoutPath, stderrPath, metaPath } =
    createRunDirectory(params.dataDir);
  const stdoutFd = fs.openSync(stdoutPath, 'a');
  const stderrFd = fs.openSync(stderrPath, 'a');
  const shell = resolveEvalShell();

  try {
    const child = spawn(shell.command, [...shell.args, shellCommand], {
      cwd: params.cwd || process.cwd(),
      detached: true,
      stdio: ['ignore', stdoutFd, stderrFd],
      env: {
        ...process.env,
        OPENAI_BASE_URL: params.env.baseUrl,
        OPENAI_API_KEY: params.env.apiKey,
        HYBRIDCLAW_EVAL_MODEL: params.env.model,
      },
    });
    child.unref();

    const meta: EvalRunMeta = {
      runId,
      ...(params.suiteId ? { suiteId: params.suiteId } : {}),
      ...(params.operation ? { operation: params.operation } : {}),
      pid: child.pid ?? null,
      startedAt: new Date().toISOString(),
      cwd: params.cwd || process.cwd(),
      command: shellCommand,
      displayCommand: params.displayCommand || prepared.command,
      openaiBaseUrl: params.env.baseUrl,
      model: params.env.model,
      baseModel: params.env.baseModel,
      authMode: params.env.authMode,
      profile: params.env.profile,
      stdoutPath,
      stderrPath,
      ...(prepared.progress
        ? {
            progress: {
              kind: prepared.progress.kind,
              label: prepared.progress.label,
              unit: prepared.progress.unit,
              total: prepared.progress.total,
              completed: 0,
              status: 'running',
              updatedAt: new Date().toISOString(),
            },
          }
        : {}),
    };
    writeRunMeta(metaPath, meta);
    if (typeof child.on === 'function') {
      child.on('exit', (code, signal) => {
        try {
          const raw = fs.readFileSync(metaPath, 'utf-8');
          const nextMeta = JSON.parse(raw) as EvalRunMeta;
          nextMeta.finishedAt = new Date().toISOString();
          nextMeta.exitCode = typeof code === 'number' ? code : null;
          nextMeta.exitSignal = signal || null;
          if (nextMeta.progress) {
            nextMeta.progress.status = 'exited';
            nextMeta.progress.updatedAt = new Date().toISOString();
          }
          writeRunMeta(metaPath, nextMeta);
          if (supportsQueuedEvalProgress(params.channelId)) {
            const notification =
              buildTau2ExitNotification(nextMeta) ||
              (params.dataDirForNotifications
                ? buildManagedSuiteSetupExitNotification(
                    nextMeta,
                    params.dataDirForNotifications,
                  )
                : null);
            if (notification) {
              enqueueEvalProgressMessage(params.channelId, notification);
            }
          }
        } catch {
          // best effort only
        }
      });
    }
    startEvalProgressTracker({
      channelId: params.channelId,
      runId,
      pid: child.pid ?? null,
      metaPath,
      stdoutPath,
      stderrPath,
      progress: prepared.progress,
    });

    const immediateExit = await waitForImmediateExit(
      child,
      params.earlyExitCheckMs ?? 0,
    );
    if (
      immediateExit &&
      ((immediateExit.code ?? 0) !== 0 || immediateExit.signal)
    ) {
      const stderrTail = tailLines(readLogFileText(stderrPath), 12);
      const stdoutTail = tailLines(readLogFileText(stdoutPath), 12);
      const failureTitle = (params.title || 'Eval Started').replace(
        /Started$/,
        'Failed',
      );
      return errorResult(
        failureTitle,
        [
          `Run ID: ${runId}`,
          `Command: ${params.displayCommand || prepared.command}`,
          `Exit code: ${immediateExit.code ?? 'unknown'}`,
          `Signal: ${immediateExit.signal || 'none'}`,
          `Stdout: ${stdoutPath}`,
          `Stderr: ${stderrPath}`,
          ...(stderrTail
            ? ['', 'Failure:', stderrTail]
            : stdoutTail
              ? ['', 'Output:', stdoutTail]
              : []),
        ].join('\n'),
      );
    }

    return infoResult(
      params.title || 'Eval Started',
      [
        `Run ID: ${runId}`,
        `PID: ${child.pid ?? 'unknown'}`,
        `Command: ${params.displayCommand || prepared.command}`,
        `CWD: ${params.cwd || process.cwd()}`,
        `Run dir: ${runDir}`,
        `Stdout: ${stdoutPath}`,
        `Stderr: ${stderrPath}`,
        `Base URL: ${params.env.baseUrl}`,
        `Model: ${params.env.model}`,
        `Base model: ${params.env.baseModel}`,
        `Auth: ${describeAuthMode(params.env)}`,
        ...(prepared.progress?.total &&
        supportsQueuedEvalProgress(params.channelId)
          ? [
              `Progress: proactive ${prepared.progress.label} bar queued to local ${params.channelId} channel (${prepared.progress.total} ${prepared.progress.unit})`,
            ]
          : []),
        ...describeEvalProfile(params.env.profile),
        ...(params.footerLines || []),
      ].join('\n'),
    );
  } finally {
    fs.closeSync(stdoutFd);
    fs.closeSync(stderrFd);
  }
}

function isTau2Alias(value: string): boolean {
  return (
    String(value || '')
      .trim()
      .toLowerCase() === 'tau2'
  );
}

function renderTau2Status(dataDir: string): string {
  const installDir = getTau2InstallDir(dataDir);
  const executablePath = getTau2ExecutablePath(dataDir);
  const installed = isTau2Installed(dataDir);
  const latestSetup = findLatestEvalRun(dataDir, (meta) =>
    isTau2RunMeta(meta, 'setup'),
  );
  const latestRun = findLatestEvalRun(dataDir, (meta) =>
    isTau2RunMeta(meta, 'run'),
  );
  const setupFailure =
    !installed && latestSetup ? describeRunFailureReason(latestSetup) : null;
  const latestRunSummary = latestRun ? readTau2RunSummary(latestRun) : null;

  return [
    `Install dir: ${installDir}`,
    `Installed: ${installed ? 'yes' : 'no'}`,
    `Executable: ${fs.existsSync(executablePath) ? executablePath : 'missing'}`,
    latestSetup
      ? `Latest setup: ${latestSetup.runId} (${readRunMetaStatus(latestSetup)})`
      : 'Latest setup: none',
    latestRun
      ? `Latest run: ${latestRun.runId} (${readRunMetaStatus(latestRun)})`
      : 'Latest run: none',
    ...(latestRun
      ? [
          `Command: ${latestRun.displayCommand || latestRun.command}`,
          ...(latestRunSummary
            ? [formatTau2SuccessLine(latestRunSummary)]
            : []),
          ...(latestRunSummary
            ? [formatTau2DbMatchLine(latestRunSummary)]
            : []),
          ...(latestRunSummary
            ? (() => {
                const conversationLine =
                  formatTau2ConversationLine(latestRunSummary);
                return conversationLine ? [conversationLine] : [];
              })()
            : formatRunProgress(latestRun)
              ? [`Progress: ${formatRunProgress(latestRun)}`]
              : []),
          `Stdout: ${latestRun.stdoutPath}`,
          `Stderr: ${latestRun.stderrPath}`,
        ]
      : []),
    ...(setupFailure ? [`Setup failure: ${setupFailure}`] : []),
    ...(!installed ? ['Run `/eval tau2 setup` first.'] : []),
  ].join('\n');
}

function renderTau2Results(dataDir: string): GatewayCommandResult {
  const latestTau2Job = findLatestEvalRun(dataDir, (meta) =>
    isTau2RunMeta(meta),
  );
  if (!latestTau2Job) {
    return errorResult(
      'tau2 Results',
      'No tau2 job found. Start with `/eval tau2 setup`, then `/eval tau2 run --domain telecom --num-trials 1 --num-tasks 10`.',
    );
  }

  const stdoutText = readLogFileText(latestTau2Job.stdoutPath);
  const stdoutTail =
    extractTau2MetricsSection(stdoutText) || tailLines(stdoutText, 40);
  const stderrTail = tailLines(readLogFileText(latestTau2Job.stderrPath), 20);
  const summary = readTau2RunSummary(latestTau2Job);
  const overviewSection = renderKeyValueSection('Overview', [
    ['Evaluated model', latestTau2Job.baseModel || latestTau2Job.model],
    ['Harness', `HybridClaw v${resolveHarnessVersion()}`],
    ['Status', readRunMetaStatus(latestTau2Job)],
  ]);
  const outcomeSection = renderKeyValueSection('Results', [
    ['Success', summary ? formatTau2SuccessLine(summary) : null],
    ['DB match', summary ? formatTau2DbMatchLine(summary) : null],
    [
      'Conversations',
      summary
        ? formatTau2ConversationLine(summary)
        : formatRunProgress(latestTau2Job)
          ? `Progress: ${formatRunProgress(latestTau2Job)}`
          : null,
    ],
  ]);
  const runSection = renderKeyValueSection('Run', [
    ['Run ID', latestTau2Job.runId],
    ['Command', latestTau2Job.displayCommand || latestTau2Job.command],
  ]);
  const pathsSection = renderKeyValueSection('Paths', [
    ['Stdout', latestTau2Job.stdoutPath],
    ['Stderr', latestTau2Job.stderrPath],
  ]);
  return infoResult(
    'tau2 Results',
    joinSections([
      overviewSection,
      outcomeSection,
      runSection,
      pathsSection,
      renderKeyValueSection('Stdout tail', [
        ['Output', stdoutTail || '(empty)'],
      ]),
      renderKeyValueSection('Stderr tail', [
        ['Output', stderrTail || '(empty)'],
      ]),
    ]),
  );
}

async function handleTau2Setup(params: {
  dataDir: string;
  env: EvalEnvironment;
  channelId?: string;
}): Promise<GatewayCommandResult> {
  const activeSetup = findLatestEvalRun(
    params.dataDir,
    (meta) => isTau2RunMeta(meta, 'setup') && isRunMetaActive(meta),
  );
  if (activeSetup) {
    return infoResult(
      'tau2 Setup Running',
      [
        `Run ID: ${activeSetup.runId}`,
        `PID: ${activeSetup.pid ?? 'unknown'}`,
        'A detached tau2 setup is already running.',
        'Use `/eval tau2 status` to check state.',
        'Use `/eval tau2 results` to inspect setup logs.',
      ].join('\n'),
    );
  }
  const setupSpec = getTau2SetupSpec(params.dataDir);
  return startDetachedEvalRun({
    command: setupSpec.command,
    commandArgs: ['tau2', 'setup'],
    displayCommand: 'tau2 setup',
    dataDir: params.dataDir,
    env: params.env,
    channelId: params.channelId,
    cwd: getEvalBaseDir(params.dataDir),
    suiteId: 'tau2',
    operation: 'setup',
    title: 'tau2 Setup Started',
    footerLines: [
      'Detached setup job started.',
      `Setup strategy: ${setupSpec.strategy === 'uv' ? 'uv-managed Python 3.12 venv with tau2 CLI smoke test' : 'system python venv'}.`,
      'Use `/eval tau2 status` to check whether setup has finished.',
      'Use `/eval tau2 results` to inspect setup logs.',
    ],
    earlyExitCheckMs: EVAL_EARLY_EXIT_CHECK_MS,
  });
}

async function handleTau2Run(params: {
  dataDir: string;
  env: EvalEnvironment;
  channelId?: string;
  args: string[];
}): Promise<GatewayCommandResult> {
  if (!isTau2Installed(params.dataDir)) {
    const latestSetup = findLatestEvalRun(params.dataDir, (meta) =>
      isTau2RunMeta(meta, 'setup'),
    );
    if (latestSetup && isRunMetaActive(latestSetup)) {
      return errorResult(
        'tau2 Setup Running',
        [
          'tau2 setup is still running.',
          'Wait for `/eval tau2 status` to show setup finished, then run tau2 again.',
          'Use `/eval tau2 results` to inspect the setup logs.',
        ].join('\n'),
      );
    }
    return errorResult(
      'tau2 Setup Required',
      latestSetup
        ? 'tau2 is not installed. The last setup job did not complete successfully. Check `/eval tau2 results`, then rerun `/eval tau2 setup`.'
        : 'tau2 is not installed yet. Run `/eval tau2 setup` first.',
    );
  }
  const prepared = prepareEvalRun(['tau2', 'run', ...params.args]);
  const executablePath = getTau2ExecutablePath(params.dataDir);
  const actualCommand = buildCommandString([
    quoteShellArg(executablePath),
    ...prepared.commandArgs.slice(1),
  ]);
  return startDetachedEvalRun({
    command: actualCommand,
    commandArgs: prepared.commandArgs,
    displayCommand: prepared.command,
    dataDir: params.dataDir,
    env: params.env,
    channelId: params.channelId,
    cwd: getTau2InstallDir(params.dataDir),
    suiteId: 'tau2',
    operation: 'run',
    title: 'tau2 Run Started',
    footerLines: [
      'Use `/eval tau2 status` and `/eval tau2 results` to follow this run.',
    ],
  });
}

function handleTau2Stop(dataDir: string): GatewayCommandResult {
  const activeRun = findLatestEvalRun(
    dataDir,
    (meta) => isTau2RunMeta(meta) && isRunMetaActive(meta),
  );
  if (!activeRun) {
    return infoResult(
      'tau2 Stop',
      'No running tau2 setup or eval process found.',
    );
  }
  if (!killDetachedProcess(activeRun.pid)) {
    return errorResult(
      'tau2 Stop',
      `Failed to stop ${activeRun.operation || 'tau2'} run ${activeRun.runId}.`,
    );
  }
  try {
    const metaPath = findEvalRunMetaPath(dataDir, activeRun.runId);
    if (metaPath) {
      const latest = {
        ...activeRun,
        finishedAt: new Date().toISOString(),
        exitCode: null,
        exitSignal: 'SIGTERM',
        ...(activeRun.progress
          ? {
              progress: {
                ...activeRun.progress,
                status: 'exited' as const,
                updatedAt: new Date().toISOString(),
              },
            }
          : {}),
      };
      writeRunMeta(metaPath, latest);
    }
  } catch {
    // ignore metadata rewrite failure
  }
  return infoResult(
    'tau2 Stop',
    `Sent SIGTERM to tau2 ${activeRun.operation || 'run'} ${activeRun.runId} (pid ${activeRun.pid ?? 'unknown'}).`,
  );
}

function renderManagedSuiteStatus(
  suite: EvalSuiteDefinition,
  dataDir: string,
): string {
  const installDir = getManagedSuiteInstallDir(suite, dataDir);
  const markerPath = getManagedSuiteMarkerPath(suite, dataDir);
  const executablePath = getManagedSuiteExecutablePath(suite, dataDir);
  const installed = isManagedSuiteInstalled(suite, dataDir);
  const latestSetup = findLatestEvalRun(
    dataDir,
    (meta) => meta.suiteId === suite.id && meta.operation === 'setup',
  );
  const latestRun = findLatestEvalRun(
    dataDir,
    (meta) => meta.suiteId === suite.id && meta.operation === 'run',
  );
  const latestTerminalBenchSummary =
    suite.id === 'terminal-bench-2.0' && latestRun
      ? readTerminalBenchNativeSummary(latestRun)
      : null;
  const setupFailure =
    !installed && latestSetup ? describeRunFailureReason(latestSetup) : null;

  return [
    `Install dir: ${installDir}`,
    `Installed: ${installed ? 'yes' : 'no'}`,
    `Marker: ${fs.existsSync(markerPath) ? markerPath : 'missing'}`,
    ...(executablePath
      ? [
          `Executable: ${fs.existsSync(executablePath) ? executablePath : 'missing'}`,
        ]
      : []),
    latestSetup
      ? `Latest setup: ${latestSetup.runId} (${readRunMetaStatus(latestSetup)})`
      : 'Latest setup: none',
    latestRun
      ? `Latest run: ${latestRun.runId} (${describeManagedSuiteRunLifecycle(
          latestRun,
          latestTerminalBenchSummary,
        )})`
      : 'Latest run: none',
    ...(latestRun
      ? [
          `Command: ${latestRun.displayCommand || latestRun.command}`,
          `Stdout: ${latestRun.stdoutPath}`,
          `Stderr: ${latestRun.stderrPath}`,
          ...(latestTerminalBenchSummary
            ? [
                `Score: ${latestTerminalBenchSummary.mean.toFixed(3)}`,
                `Trials: ${latestTerminalBenchSummary.trials}`,
                `Passed: ${latestTerminalBenchSummary.passed}/${latestTerminalBenchSummary.trials}`,
                `Errors: ${latestTerminalBenchSummary.errors}`,
              ]
            : []),
        ]
      : []),
    ...(setupFailure ? [`Setup failure: ${setupFailure}`] : []),
    ...(!installed ? [`Run \`/eval ${suite.id} setup\` first.`] : []),
  ].join('\n');
}

function renderManagedSuiteResults(
  suite: EvalSuiteDefinition,
  dataDir: string,
): GatewayCommandResult {
  const latestRun = findLatestEvalRun(
    dataDir,
    (meta) => meta.suiteId === suite.id && meta.operation === 'run',
  );
  const latestSetup = findLatestEvalRun(
    dataDir,
    (meta) => meta.suiteId === suite.id && meta.operation === 'setup',
  );
  const latestJob = latestRun || latestSetup;
  if (!latestJob) {
    return errorResult(
      `${suite.title} Results`,
      `No ${suite.title} setup job found. Start with \`/eval ${suite.id} setup\`.`,
    );
  }

  const terminalBenchSummary =
    suite.id === 'terminal-bench-2.0' && latestJob.operation === 'run'
      ? readTerminalBenchNativeSummary(latestJob)
      : null;
  const terminalBenchProgress =
    suite.id === 'terminal-bench-2.0' && latestJob.operation === 'run'
      ? readTerminalBenchNativeProgress(latestJob)
      : null;
  if (suite.id === 'terminal-bench-2.0') {
    const overviewSection = renderKeyValueSection('Overview', [
      ['Evaluated model', latestJob.baseModel || latestJob.model],
      ['Harness', `HybridClaw v${resolveHarnessVersion()}`],
      [
        'Status',
        describeManagedSuiteRunLifecycle(latestJob, terminalBenchSummary),
      ],
    ]);
    const outcomeSection = renderKeyValueSection(
      terminalBenchSummary ? 'Results' : 'Progress',
      terminalBenchSummary
        ? [
            ['Score', terminalBenchSummary.mean.toFixed(3)],
            ['Trials', terminalBenchSummary.trials],
            [
              'Passed',
              `${terminalBenchSummary.passed}/${terminalBenchSummary.trials}`,
            ],
            ['Errors', terminalBenchSummary.errors],
            [
              'Tokens',
              formatTerminalBenchTokenUsage(terminalBenchSummary.tokenUsage),
            ],
          ]
        : [
            ['Tasks', terminalBenchProgress?.totalTasks ?? null],
            [
              'Finished',
              terminalBenchProgress
                ? `${terminalBenchProgress.finished}/${terminalBenchProgress.totalTasks ?? '?'}`
                : null,
            ],
            ['Passed', terminalBenchProgress?.passed ?? null],
            ['Failed', terminalBenchProgress?.failed ?? null],
            ['Running', terminalBenchProgress?.running ?? null],
            ['Pending', terminalBenchProgress?.pending ?? null],
            [
              'Tokens',
              formatTerminalBenchTokenUsage(terminalBenchProgress?.tokenUsage),
            ],
          ],
    );
    const runSection = renderKeyValueSection('Run', [
      ['Run ID', latestJob.runId],
      ['Command', latestJob.displayCommand || latestJob.command],
    ]);
    const pathsSection = renderKeyValueSection('Paths', [
      [
        'Job dir',
        terminalBenchSummary?.jobDir || terminalBenchProgress?.jobDir || null,
      ],
      ['Result JSON', terminalBenchSummary?.resultPath || null],
      ['Stdout', latestJob.stdoutPath],
      ['Stderr', latestJob.stderrPath],
    ]);
    return infoResult(
      `${suite.title} Results`,
      joinSections([overviewSection, outcomeSection, runSection, pathsSection]),
    );
  }
  return infoResult(
    `${suite.title} Results`,
    [
      `Run ID: ${latestJob.runId}`,
      `Operation: ${latestJob.operation || 'setup'}`,
      `Status: ${describeManagedSuiteRunLifecycle(latestJob, terminalBenchSummary)}`,
      `Command: ${latestJob.displayCommand || latestJob.command}`,
      `Stdout: ${latestJob.stdoutPath}`,
      `Stderr: ${latestJob.stderrPath}`,
      ...(terminalBenchSummary
        ? [
            `Job dir: ${terminalBenchSummary.jobDir}`,
            `Result JSON: ${terminalBenchSummary.resultPath}`,
            `Score: ${terminalBenchSummary.mean.toFixed(3)}`,
            `Trials: ${terminalBenchSummary.trials}`,
            `Passed: ${terminalBenchSummary.passed}/${terminalBenchSummary.trials}`,
            `Errors: ${terminalBenchSummary.errors}`,
          ]
        : terminalBenchProgress
          ? [
              `Job dir: ${terminalBenchProgress.jobDir}`,
              ...(terminalBenchProgress.totalTasks != null
                ? [`Tasks: ${terminalBenchProgress.totalTasks}`]
                : []),
              `Finished: ${terminalBenchProgress.finished}/${terminalBenchProgress.totalTasks ?? '?'}`,
              `Passed: ${terminalBenchProgress.passed}`,
              `Failed: ${terminalBenchProgress.failed}`,
              `Running: ${terminalBenchProgress.running}`,
              ...(terminalBenchProgress.pending != null
                ? [`Pending: ${terminalBenchProgress.pending}`]
                : []),
            ]
          : []),
    ].join('\n'),
  );
}

function renderManagedSuiteLogs(
  suite: EvalSuiteDefinition,
  dataDir: string,
): GatewayCommandResult {
  const latestRun = findLatestEvalRun(
    dataDir,
    (meta) => meta.suiteId === suite.id && meta.operation === 'run',
  );
  const latestSetup = findLatestEvalRun(
    dataDir,
    (meta) => meta.suiteId === suite.id && meta.operation === 'setup',
  );
  const latestJob = latestRun || latestSetup;
  if (!latestJob) {
    return errorResult(
      `${suite.title} Logs`,
      `No ${suite.title} setup job found. Start with \`/eval ${suite.id} setup\`.`,
    );
  }

  const stdoutTail = tailLines(readLogFileText(latestJob.stdoutPath), 40);
  const stderrTail = tailLines(readLogFileText(latestJob.stderrPath), 20);
  return infoResult(
    `${suite.title} Logs`,
    [
      `Run ID: ${latestJob.runId}`,
      `Operation: ${latestJob.operation || 'setup'}`,
      `Status: ${readRunMetaStatus(latestJob)}`,
      `Command: ${latestJob.displayCommand || latestJob.command}`,
      `Stdout: ${latestJob.stdoutPath}`,
      `Stderr: ${latestJob.stderrPath}`,
      '',
      'Stdout tail:',
      stdoutTail || '(empty)',
      '',
      'Stderr tail:',
      stderrTail || '(empty)',
    ].join('\n'),
  );
}

async function handleManagedSuiteSetup(params: {
  suite: EvalSuiteDefinition;
  dataDir: string;
  env: EvalEnvironment;
  channelId?: string;
}): Promise<GatewayCommandResult> {
  const managed = getManagedSuiteSetup(params.suite);
  if (!managed) {
    return errorResult(
      `${params.suite.title} Setup`,
      `Managed setup is not available for ${params.suite.title}.`,
    );
  }
  const activeSetup = findLatestEvalRun(
    params.dataDir,
    (meta) =>
      meta.suiteId === params.suite.id &&
      meta.operation === 'setup' &&
      isRunMetaActive(meta),
  );
  if (activeSetup) {
    return infoResult(
      `${params.suite.title} Setup Running`,
      [
        `Run ID: ${activeSetup.runId}`,
        `PID: ${activeSetup.pid ?? 'unknown'}`,
        'A detached setup job is already running.',
        `Use \`/eval ${params.suite.id} status\` to check state.`,
        `Use \`/eval ${params.suite.id} results\` to inspect setup logs.`,
      ].join('\n'),
    );
  }
  if (params.suite.id === 'terminal-bench-2.0') {
    ensureTerminalBenchDatasetHelper(params.dataDir);
  }
  const setupSpec = getManagedSuiteSetupCommand(params.suite, params.dataDir);
  return startDetachedEvalRun({
    command: setupSpec.command,
    commandArgs: [params.suite.id, 'setup'],
    displayCommand: `${params.suite.id} setup`,
    dataDir: params.dataDir,
    env: params.env,
    channelId: params.channelId,
    cwd: getEvalBaseDir(params.dataDir),
    suiteId: params.suite.id,
    operation: 'setup',
    title: `${params.suite.title} Setup Started`,
    footerLines: [
      'Detached setup job started.',
      `Setup strategy: ${managed.strategyDescription}.`,
      `Use \`/eval ${params.suite.id} status\` to check whether setup has finished.`,
      `Use \`/eval ${params.suite.id} results\` for the summary.`,
      `Use \`/eval ${params.suite.id} logs\` to inspect setup logs.`,
    ],
    earlyExitCheckMs: EVAL_EARLY_EXIT_CHECK_MS,
    dataDirForNotifications: params.dataDir,
  });
}

async function handleManagedSuiteRun(params: {
  suite: EvalSuiteDefinition;
  dataDir: string;
  env: EvalEnvironment;
  effectiveAgentId?: string;
  channelId?: string;
  args: string[];
}): Promise<GatewayCommandResult> {
  if (!isManagedSuiteInstalled(params.suite, params.dataDir)) {
    return errorResult(
      `${params.suite.title} Setup Required`,
      `Run \`/eval ${params.suite.id} setup\` first.`,
    );
  }
  if (
    params.suite.id === 'terminal-bench-2.0' &&
    params.env.profile.workspaceMode === 'fresh-agent'
  ) {
    return errorResult(
      `${params.suite.title} Run`,
      'Native Terminal-Bench does not support `--fresh-agent` yet. Use the current agent setup for now.',
    );
  }

  const prepared = prepareManagedSuiteRun(
    params.suite,
    params.dataDir,
    params.env,
    params.effectiveAgentId || 'main',
    params.args,
  );
  if (!prepared) {
    return errorResult(
      `${params.suite.title} Run`,
      `Managed run is not available for ${params.suite.title}.`,
    );
  }

  return await startDetachedEvalRun({
    command: prepared.command,
    commandArgs: prepared.commandArgs,
    displayCommand: prepared.displayCommand,
    dataDir: params.dataDir,
    env: params.env,
    channelId: params.channelId,
    cwd: prepared.cwd,
    suiteId: params.suite.id,
    operation: 'run',
    title: `${params.suite.title} Run Started`,
    footerLines: [
      `Use \`/eval ${params.suite.id} status\` and \`/eval ${params.suite.id} results\` to follow this run.`,
      `Use \`/eval ${params.suite.id} logs\` for tailed stdout/stderr.`,
    ],
    dataDirForNotifications: params.dataDir,
  });
}

function handleManagedSuiteStop(
  suite: EvalSuiteDefinition,
  dataDir: string,
): GatewayCommandResult {
  const activeRun = findLatestEvalRun(
    dataDir,
    (meta) =>
      meta.suiteId === suite.id &&
      (meta.operation === 'run' || meta.operation === 'setup') &&
      isRunMetaActive(meta),
  );
  if (!activeRun) {
    return infoResult(
      `${suite.title} Stop`,
      `No running ${suite.title} setup or eval process found.`,
    );
  }
  if (!killDetachedProcess(activeRun.pid)) {
    return errorResult(
      `${suite.title} Stop`,
      `Failed to stop ${activeRun.operation || suite.id} run ${activeRun.runId}.`,
    );
  }
  try {
    const metaPath = findEvalRunMetaPath(dataDir, activeRun.runId);
    if (metaPath) {
      const latest = {
        ...activeRun,
        finishedAt: new Date().toISOString(),
        exitCode: null,
        exitSignal: 'SIGTERM',
        ...(activeRun.progress
          ? {
              progress: {
                ...activeRun.progress,
                status: 'exited' as const,
                updatedAt: new Date().toISOString(),
              },
            }
          : {}),
      };
      writeRunMeta(metaPath, latest);
    }
  } catch {
    // ignore metadata rewrite failure
  }
  return infoResult(
    `${suite.title} Stop`,
    `Stopped ${activeRun.operation || suite.id} run ${activeRun.runId}.`,
  );
}

async function handleManagedSuiteCommand(params: {
  suite: EvalSuiteDefinition;
  dataDir: string;
  env: EvalEnvironment;
  effectiveAgentId?: string;
  channelId?: string;
  subcommand?: string;
  args?: string[];
}): Promise<GatewayCommandResult> {
  const subcommand = String(params.subcommand || '')
    .trim()
    .toLowerCase();
  if (!isImplementedManagedSuite(params.suite)) {
    if (!subcommand || ['help', '--help', '-h'].includes(subcommand)) {
      return infoResult(
        params.suite.title,
        renderUnimplementedSuite(params.suite, params.env),
      );
    }
    return errorResult(
      `${params.suite.title}`,
      [
        `${params.suite.title} is not implemented yet.`,
        '',
        'Implemented suites today:',
        '- `/eval terminal-bench-2.0 ...`',
        '- `/eval tau2 ...`',
      ].join('\n'),
    );
  }
  if (!subcommand || ['help', '--help', '-h'].includes(subcommand)) {
    return infoResult(
      params.suite.title,
      renderRecipe(params.suite, params.env),
    );
  }
  switch (subcommand) {
    case 'setup':
      return await handleManagedSuiteSetup(params);
    case 'run':
      return await handleManagedSuiteRun({
        suite: params.suite,
        dataDir: params.dataDir,
        env: params.env,
        effectiveAgentId: params.effectiveAgentId,
        channelId: params.channelId,
        args: params.args || [],
      });
    case 'status':
      return infoResult(
        `${params.suite.title} Status`,
        renderManagedSuiteStatus(params.suite, params.dataDir),
      );
    case 'stop':
      return handleManagedSuiteStop(params.suite, params.dataDir);
    case 'results':
      return renderManagedSuiteResults(params.suite, params.dataDir);
    case 'logs':
      return renderManagedSuiteLogs(params.suite, params.dataDir);
    default:
      return errorResult(
        `${params.suite.title} Usage`,
        [
          `Unknown ${params.suite.id} command: \`${subcommand}\`.`,
          '',
          renderRecipe(params.suite, params.env),
        ].join('\n'),
      );
  }
}

async function handleTau2Command(params: {
  dataDir: string;
  env: EvalEnvironment;
  channelId?: string;
  subcommand?: string;
  args: string[];
}): Promise<GatewayCommandResult> {
  const subcommand = String(params.subcommand || '')
    .trim()
    .toLowerCase();
  if (!subcommand || ['help', '--help', '-h'].includes(subcommand)) {
    return infoResult('tau2', renderTau2Usage(params.env, params.dataDir));
  }
  switch (subcommand) {
    case 'setup':
      return await handleTau2Setup(params);
    case 'run':
      return await handleTau2Run(params);
    case 'status':
      return infoResult('tau2 Status', renderTau2Status(params.dataDir));
    case 'stop':
      return handleTau2Stop(params.dataDir);
    case 'results':
      return renderTau2Results(params.dataDir);
    default:
      return errorResult(
        'tau2 Usage',
        [
          `Unknown tau2 command: \`${subcommand}\`.`,
          '',
          renderTau2Usage(params.env, params.dataDir),
        ].join('\n'),
      );
  }
}

function parseEvalProfileFlag(
  arg: string,
  profile: EvalProfile,
): string | null {
  const normalized = String(arg || '').trim();
  const lower = normalized.toLowerCase();
  if (!normalized.startsWith('--')) return null;
  if (lower.startsWith('--include-prompt=')) {
    const rawParts = normalized.slice('--include-prompt='.length);
    const parts = rawParts
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean);
    if (parts.length === 0) {
      return 'Expected at least one prompt part in `--include-prompt=`.';
    }
    const unknown = parts.find((part) => !isKnownEvalPromptPart(part));
    if (unknown) {
      return `Unknown prompt part: \`${unknown}\`.`;
    }
    profile.includePromptParts.push(
      ...parts.filter(
        (part): part is (typeof profile.includePromptParts)[number] =>
          isKnownEvalPromptPart(part),
      ),
    );
    return null;
  }
  if (lower.startsWith('--omit-prompt=')) {
    const rawParts = normalized.slice('--omit-prompt='.length);
    const parts = rawParts
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean);
    if (parts.length === 0) {
      return 'Expected at least one prompt part in `--omit-prompt=`.';
    }
    const unknown = parts.find((part) => !isKnownEvalPromptPart(part));
    if (unknown) {
      return `Unknown prompt part: \`${unknown}\`.`;
    }
    profile.omitPromptParts.push(
      ...parts.filter(
        (part): part is (typeof profile.omitPromptParts)[number] =>
          isKnownEvalPromptPart(part),
      ),
    );
    return null;
  }
  switch (lower) {
    case '--current-agent':
      profile.workspaceMode = 'current-agent';
      return null;
    case '--fresh-agent':
      profile.workspaceMode = 'fresh-agent';
      delete profile.agentId;
      return null;
    case '--ablate-system':
      profile.ablateSystemPrompt = true;
      return null;
    default:
      return `Unknown eval option: \`${arg}\`.`;
  }
}

function finalizeEvalProfile(profile: EvalProfile): EvalProfile {
  if (profile.workspaceMode === 'fresh-agent') {
    delete profile.agentId;
  }
  profile.includePromptParts = Array.from(new Set(profile.includePromptParts));
  profile.omitPromptParts = Array.from(new Set(profile.omitPromptParts));
  return profile;
}

function parseEvalAction(
  args: string[],
  effectiveAgentId?: string,
): {
  action: string;
  profile: EvalProfile;
  commandArgs: string[];
  error?: string;
} {
  const profile = buildDefaultEvalProfile(effectiveAgentId);
  if (
    args.length === 1 &&
    ['help', '--help', '-h'].includes(
      String(args[0] || '')
        .trim()
        .toLowerCase(),
    )
  ) {
    return {
      action: 'help',
      profile: finalizeEvalProfile(profile),
      commandArgs: [],
    };
  }
  let index = 0;

  while (index < args.length && args[index]?.startsWith('--')) {
    const error = parseEvalProfileFlag(args[index], profile);
    if (error) return { action: '', profile, commandArgs: [], error };
    index += 1;
  }

  const action = String(args[index] || '')
    .trim()
    .toLowerCase();
  if (!action) {
    return {
      action: '',
      profile: finalizeEvalProfile(profile),
      commandArgs: [],
    };
  }
  const rawAction = String(args[index] || '').trim();
  index += 1;

  if (action === 'run') {
    return {
      action: '',
      profile: finalizeEvalProfile(profile),
      commandArgs: [],
      error:
        'Use `/eval <shell command...>` instead of `/eval run <shell command...>`.',
    };
  }

  if (action === 'list' || action === 'env' || findSuite(action)) {
    while (index < args.length) {
      if (!args[index]?.startsWith('--')) {
        return {
          action: 'run',
          profile: finalizeEvalProfile(profile),
          commandArgs: [rawAction, ...args.slice(index)],
        };
      }
      const error = parseEvalProfileFlag(args[index], profile);
      if (error) {
        return {
          action: 'run',
          profile: finalizeEvalProfile(profile),
          commandArgs: [rawAction, ...args.slice(index)],
        };
      }
      index += 1;
    }

    return {
      action,
      profile: finalizeEvalProfile(profile),
      commandArgs: [],
    };
  }

  return {
    action: 'run',
    profile: finalizeEvalProfile(profile),
    commandArgs: [rawAction, ...args.slice(index)],
  };
}

export async function handleEvalCommand(
  params: HandleEvalCommandParams,
): Promise<GatewayCommandResult> {
  const parsed = parseEvalAction(params.args, params.effectiveAgentId);
  if (parsed.error) {
    return errorResult('Eval Usage', parsed.error);
  }
  const env = buildEvalEnvironment({
    gatewayBaseUrl: params.gatewayBaseUrl,
    webApiToken: params.webApiToken,
    effectiveModel: params.effectiveModel,
    profile: parsed.profile,
  });
  const action = parsed.action;

  if (!action || action === 'help' || action === '--help' || action === '-h') {
    return infoResult('Eval', renderUsage(env));
  }

  if (action === 'list') {
    return infoResult('Eval', renderUsage(env));
  }

  if (action === 'env') {
    return infoResult('Eval Environment', renderEnv(env));
  }

  if (isTau2Alias(action)) {
    return await handleTau2Command({
      dataDir: params.dataDir,
      env,
      channelId: params.channelId,
      subcommand: 'help',
      args: [],
    });
  }

  if (action === 'run') {
    if (isTau2Alias(parsed.commandArgs[0] || '')) {
      return await handleTau2Command({
        dataDir: params.dataDir,
        env,
        channelId: params.channelId,
        subcommand: parsed.commandArgs[1],
        args: parsed.commandArgs.slice(2),
      });
    }
    const managedSuite = findSuite(parsed.commandArgs[0] || '');
    if (managedSuite) {
      const managedSubcommand = String(parsed.commandArgs[1] || '')
        .trim()
        .toLowerCase();
      if (MANAGED_SUITE_SUBCOMMANDS.has(managedSubcommand)) {
        return await handleManagedSuiteCommand({
          suite: managedSuite,
          dataDir: params.dataDir,
          env,
          effectiveAgentId: params.effectiveAgentId,
          channelId: params.channelId,
          subcommand: managedSubcommand,
          args: parsed.commandArgs.slice(2),
        });
      }
    }
    const probableSuite = String(parsed.commandArgs[0] || '').trim();
    const probableSubcommand = String(parsed.commandArgs[1] || '')
      .trim()
      .toLowerCase();
    const prefixMatches = findSuitePrefixMatches(probableSuite);
    if (
      probableSuite &&
      !managedSuite &&
      prefixMatches.length === 1 &&
      (parsed.commandArgs.length === 1 ||
        MANAGED_SUITE_SUBCOMMANDS.has(probableSubcommand))
    ) {
      const suggestedSuite = prefixMatches[0];
      return errorResult(
        'Unknown Eval',
        [
          `Unknown eval suite: \`${probableSuite}\`.`,
          `Did you mean \`${suggestedSuite.id}\`?`,
          '',
          `Try \`/eval ${suggestedSuite.id}\` or \`/eval ${suggestedSuite.id} ${probableSubcommand || 'run'} ...\`.`,
        ].join('\n'),
      );
    }
    const prepared = prepareEvalRun(parsed.commandArgs);
    if (!prepared.command) {
      return errorResult(
        'Usage',
        'Usage: `/eval [--current-agent|--fresh-agent] [--ablate-system] [--include-prompt=<parts>] [--omit-prompt=<parts>] <shell command...>`',
      );
    }
    return await startDetachedEvalRun({
      command: prepared.command,
      commandArgs: prepared.commandArgs,
      dataDir: params.dataDir,
      env,
      channelId: params.channelId,
    });
  }

  const suite = findSuite(action);
  if (!suite) {
    return errorResult(
      'Unknown Eval',
      [
        `Unknown eval suite: \`${action}\`.`,
        '',
        'Supported suites:',
        ...renderSuiteList(),
      ].join('\n'),
    );
  }

  return await handleManagedSuiteCommand({
    suite,
    dataDir: params.dataDir,
    env,
    effectiveAgentId: params.effectiveAgentId,
    channelId: params.channelId,
    subcommand: 'help',
  });
}
