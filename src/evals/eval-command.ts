import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
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

const MAX_QUEUED_EVAL_MESSAGES = 200;
const EVAL_PROGRESS_BAR_WIDTH = 20;
const EVAL_PROGRESS_POLL_INTERVAL_MS = 1000;
const EVAL_EARLY_EXIT_CHECK_MS = 1500;
const TAU2_REPO_URL = 'https://github.com/sierra-research/tau2-bench';
const TAU2_INSTALL_DIRNAME = 'tau2-bench';
const SWEBENCH_REPO_URL = 'https://github.com/princeton-nlp/SWE-bench.git';
const AGENTBENCH_REPO_URL = 'https://github.com/THUDM/AgentBench.git';

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
    summary: 'Sandboxed terminal-task benchmark typically run through Harbor.',
    aliases: ['terminal-bench', 'terminal-bench-2', 'terminalbench'],
    prereqs: [
      'Python',
      'Docker',
      '`pip install harbor`',
      'A Harbor agent adapter that reads `OPENAI_BASE_URL` and `OPENAI_API_KEY`.',
    ],
    starter: [
      'harbor run -d terminal-bench@2.0 \\',
      '  --agent <your-harbor-agent> \\',
      '  --model "$HYBRIDCLAW_EVAL_MODEL" \\',
      '  --n-concurrent 4 \\',
      '  --n-attempts 5',
    ],
    notes: [
      'Keep your Harbor agent config on the benchmark side; HybridClaw only provides the OpenAI-compatible endpoint and auth injection.',
      'Run the oracle check from Harbor first to validate your local install before launching your own agent.',
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

function renderSuiteList(): string[] {
  return EVAL_SUITES.map((suite) => `- ${suite.id} — ${suite.summary}`);
}

function renderUsage(env: EvalEnvironment): string {
  return [
    "Local eval helper for HybridClaw's OpenAI-compatible gateway.",
    '',
    'Usage:',
    '- `/eval list`',
    '- `/eval env [--current-agent|--fresh-agent] [--ablate-system] [--include-prompt=<parts>] [--omit-prompt=<parts>]`',
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
  ].join('\n');
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
    'Managed setup:',
    `- \`/eval ${suite.id} setup\``,
    ...(suite.id === 'terminal-bench-2.0'
      ? [`- \`/eval ${suite.id} run --num-tasks 10\``]
      : []),
    `- \`/eval ${suite.id} status\``,
    `- \`/eval ${suite.id} results\``,
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
  switch (suite.id) {
    case 'swebench-verified':
      return {
        installDirName: 'swebench',
        strategyDescription:
          'uv-managed Python 3.12 venv with editable SWE-bench install',
      };
    case 'terminal-bench-2.0':
      return {
        installDirName: 'terminal-bench-2.0',
        strategyDescription:
          'uv-managed Python 3.12 venv with Harbor CLI install and HybridClaw Harbor agent smoke test',
      };
    case 'agentbench':
      return {
        installDirName: 'agentbench',
        strategyDescription:
          'uv-managed Python 3.12 venv with AgentBench requirements install',
      };
    case 'gaia':
      return {
        installDirName: 'gaia',
        strategyDescription:
          'uv-managed Python 3.12 venv with Inspect AI + inspect-evals install',
      };
    default:
      return null;
  }
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
  const installDir = getManagedSuiteInstallDir(suite, dataDir);
  if (suite.id === 'terminal-bench-2.0') {
    return process.platform === 'win32'
      ? path.join(installDir, '.venv', 'Scripts', 'harbor.exe')
      : path.join(installDir, '.venv', 'bin', 'harbor');
  }
  if (suite.id === 'gaia') {
    return process.platform === 'win32'
      ? path.join(installDir, '.venv', 'Scripts', 'inspect.exe')
      : path.join(installDir, '.venv', 'bin', 'inspect');
  }
  return null;
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
    switch (suite.id) {
      case 'swebench-verified':
        return `${quoteShellArg(venvPython)} -c "import swebench"`;
      case 'terminal-bench-2.0': {
        return `${quoteShellArg(venvPython)} -c "import hybridclaw_harbor_agent"`;
      }
      case 'agentbench':
        return process.platform === 'win32'
          ? `${quoteShellArg(venvPython)} eval.py --help >NUL`
          : `${quoteShellArg(venvPython)} eval.py --help >/dev/null`;
      case 'gaia': {
        const inspectExe =
          process.platform === 'win32'
            ? '.venv\\Scripts\\inspect.exe'
            : '.venv/bin/inspect';
        return `${quoteShellArg(inspectExe)} eval --help`;
      }
    }
  })();
  const installStep = (() => {
    switch (suite.id) {
      case 'swebench-verified':
        return `uv pip install --python ${quoteShellArg(venvPython)} -e .`;
      case 'terminal-bench-2.0':
        return `uv pip install --python ${quoteShellArg(venvPython)} harbor`;
      case 'agentbench':
        return `uv pip install --python ${quoteShellArg(venvPython)} -r requirements.txt`;
      case 'gaia':
        return `uv pip install --python ${quoteShellArg(venvPython)} inspect-ai inspect-evals`;
    }
  })();
  const fallbackInstallStep = (() => {
    switch (suite.id) {
      case 'swebench-verified':
        return 'python -m pip install -e .';
      case 'terminal-bench-2.0':
        return 'python -m pip install harbor';
      case 'agentbench':
        return 'python -m pip install -r requirements.txt';
      case 'gaia':
        return 'python -m pip install inspect-ai inspect-evals';
    }
  })();
  const repoSyncStep = (() => {
    switch (suite.id) {
      case 'swebench-verified':
        return process.platform === 'win32'
          ? `if exist ${quoteShellArg(path.join(installDir, '.git'))} (git -C ${installDirQuoted} pull --ff-only) else (git clone ${quoteShellArg(SWEBENCH_REPO_URL)} ${installDirQuoted})`
          : `if [ -d ${quoteShellArg(path.join(installDir, '.git'))} ]; then git -C ${installDirQuoted} pull --ff-only; else git clone ${quoteShellArg(SWEBENCH_REPO_URL)} ${installDirQuoted}; fi`;
      case 'agentbench':
        return process.platform === 'win32'
          ? `if exist ${quoteShellArg(path.join(installDir, '.git'))} (git -C ${installDirQuoted} pull --ff-only) else (git clone ${quoteShellArg(AGENTBENCH_REPO_URL)} ${installDirQuoted})`
          : `if [ -d ${quoteShellArg(path.join(installDir, '.git'))} ]; then git -C ${installDirQuoted} pull --ff-only; else git clone ${quoteShellArg(AGENTBENCH_REPO_URL)} ${installDirQuoted}; fi`;
      default:
        return process.platform === 'win32'
          ? `if not exist ${installDirQuoted} mkdir ${installDirQuoted}`
          : `mkdir -p ${installDirQuoted}`;
    }
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
  dataDir: string,
): string {
  const installDir = getManagedSuiteInstallDir(suite, dataDir);
  const pythonPath = getManagedSuitePythonPath(suite, dataDir);
  switch (suite.id) {
    case 'swebench-verified':
      return `/eval ${quoteShellArg(pythonPath)} -m swebench.harness.run_evaluation --dataset_name princeton-nlp/SWE-bench_Verified --predictions_path <your_patches.jsonl> --max_workers 8 --run_id hybridclaw_run`;
    case 'terminal-bench-2.0': {
      return `/eval terminal-bench-2.0 run --num-tasks 10`;
    }
    case 'agentbench':
      return `/eval cd ${quoteShellArg(installDir)} && ${quoteShellArg(pythonPath)} eval.py --config configs/your_agent_config.yaml`;
    case 'gaia': {
      const executablePath = getManagedSuiteExecutablePath(suite, dataDir);
      return `/eval ${quoteShellArg(executablePath || path.join(installDir, '.venv', 'bin', 'inspect'))} eval inspect_evals/gaia --model "$HYBRIDCLAW_EVAL_MODEL" --log-dir ./logs`;
    }
  }
}

function getTerminalBenchAdapterPath(dataDir: string): string {
  return path.join(
    getEvalBaseDir(dataDir),
    'terminal-bench-2.0',
    'hybridclaw_harbor_agent.py',
  );
}

function ensureTerminalBenchHybridClawAdapter(dataDir: string): void {
  const adapterPath = getTerminalBenchAdapterPath(dataDir);
  fs.mkdirSync(path.dirname(adapterPath), { recursive: true });
  const content = [
    'import os',
    '',
    'from harbor.agents.terminus_2.terminus_2 import Terminus2',
    '',
    '',
    'class HybridClawHarborAgent(Terminus2):',
    '    @staticmethod',
    '    def name() -> str:',
    "        return 'hybridclaw'",
    '',
    '    def version(self) -> str | None:',
    "        return '0.1.0'",
    '',
    '    def __init__(self, logs_dir, model_name=None, api_base=None, llm_kwargs=None, **kwargs):',
    "        resolved_model = model_name or os.environ.get('HYBRIDCLAW_EVAL_MODEL') or os.environ.get('OPENAI_MODEL') or 'gpt-4.1-mini'",
    "        resolved_api_base = api_base or os.environ.get('OPENAI_BASE_URL')",
    '        merged_llm_kwargs = dict(llm_kwargs or {})',
    "        api_key = os.environ.get('OPENAI_API_KEY')",
    "        if api_key and 'api_key' not in merged_llm_kwargs:",
    "            merged_llm_kwargs['api_key'] = api_key",
    '        super().__init__(',
    '            logs_dir=logs_dir,',
    '            model_name=resolved_model,',
    '            api_base=resolved_api_base,',
    '            llm_kwargs=merged_llm_kwargs,',
    '            **kwargs,',
    '        )',
    '',
  ].join('\n');
  fs.writeFileSync(adapterPath, content, 'utf-8');
}

function prepareManagedSuiteRun(
  suite: EvalSuiteDefinition,
  dataDir: string,
  args: string[],
): ManagedSuiteRunPreparation | null {
  if (suite.id !== 'terminal-bench-2.0') return null;
  const executablePath = getManagedSuiteExecutablePath(suite, dataDir);
  if (!executablePath) return null;
  ensureTerminalBenchHybridClawAdapter(dataDir);

  const translatedArgs: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const current = String(args[index] || '').trim();
    if (!current) continue;
    if (current === '--num-tasks') {
      const next = String(args[index + 1] || '').trim();
      if (next) translatedArgs.push('-l', next);
      index += 1;
      continue;
    }
    if (current.startsWith('--num-tasks=')) {
      const value = current.slice('--num-tasks='.length).trim();
      if (value) translatedArgs.push('-l', value);
      continue;
    }
    translatedArgs.push(current);
  }

  const commandArgs = ['harbor', 'run', ...translatedArgs];
  if (
    !hasCommandOption(commandArgs, '--dataset') &&
    !hasCommandOption(commandArgs, '-d')
  ) {
    commandArgs.push('-d', 'terminal-bench@2.0');
  }
  if (
    !hasCommandOption(commandArgs, '--n-concurrent') &&
    !hasCommandOption(commandArgs, '-n')
  ) {
    const defaultConcurrency = isContainerMaxConcurrentExplicit()
      ? Math.max(1, Math.min(MAX_CONCURRENT_CONTAINERS - 1, 4))
      : 1;
    commandArgs.push('-n', String(defaultConcurrency));
  }
  if (
    !hasCommandOption(commandArgs, '--agent-import-path') &&
    !hasCommandOption(commandArgs, '--agent') &&
    !hasCommandOption(commandArgs, '-a')
  ) {
    commandArgs.push(
      '--agent-import-path',
      'hybridclaw_harbor_agent:HybridClawHarborAgent',
    );
  }
  if (
    !hasCommandOption(commandArgs, '--model') &&
    !hasCommandOption(commandArgs, '-m')
  ) {
    commandArgs.push('-m', '"$HYBRIDCLAW_EVAL_MODEL"');
  }

  return {
    commandArgs,
    command: buildCommandString([
      quoteShellArg(executablePath),
      ...commandArgs.slice(1),
    ]),
    displayCommand: buildCommandString([suite.id, 'run', ...args]),
    cwd: getManagedSuiteInstallDir(suite, dataDir),
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
      `Use \`/eval ${suite.id} results\` for the setup logs.`,
    ].join('\n');
  }
  if (meta.operation === 'run') {
    const reason = describeRunFailureReason(meta);
    if (!failed) {
      return [
        `${suite.title} run completed.`,
        '',
        `Run ID: ${meta.runId}`,
        `Use \`/eval ${suite.id} results\` for the run logs.`,
      ].join('\n');
    }
    return [
      `${suite.title} run failed.`,
      '',
      `Run ID: ${meta.runId}`,
      ...(reason ? [`Reason: ${reason}`] : []),
      `Use \`/eval ${suite.id} results\` for the run logs.`,
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
  return infoResult(
    'tau2 Results',
    [
      `Run ID: ${latestTau2Job.runId}`,
      `Operation: ${latestTau2Job.operation || 'run'}`,
      `Status: ${readRunMetaStatus(latestTau2Job)}`,
      `Command: ${latestTau2Job.displayCommand || latestTau2Job.command}`,
      ...(summary ? [formatTau2SuccessLine(summary)] : []),
      ...(summary ? [formatTau2DbMatchLine(summary)] : []),
      ...(summary
        ? (() => {
            const conversationLine = formatTau2ConversationLine(summary);
            return conversationLine ? [conversationLine] : [];
          })()
        : formatRunProgress(latestTau2Job)
          ? [`Progress: ${formatRunProgress(latestTau2Job)}`]
          : []),
      `Stdout: ${latestTau2Job.stdoutPath}`,
      `Stderr: ${latestTau2Job.stderrPath}`,
      '',
      'Stdout tail:',
      stdoutTail || '(empty)',
      '',
      'Stderr tail:',
      stderrTail || '(empty)',
    ].join('\n'),
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
      ? `Latest run: ${latestRun.runId} (${readRunMetaStatus(latestRun)})`
      : 'Latest run: none',
    ...(latestRun
      ? [
          `Command: ${latestRun.displayCommand || latestRun.command}`,
          `Stdout: ${latestRun.stdoutPath}`,
          `Stderr: ${latestRun.stderrPath}`,
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

  const stdoutTail = tailLines(readLogFileText(latestJob.stdoutPath), 40);
  const stderrTail = tailLines(readLogFileText(latestJob.stderrPath), 20);
  return infoResult(
    `${suite.title} Results`,
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
    ensureTerminalBenchHybridClawAdapter(params.dataDir);
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
      `Use \`/eval ${params.suite.id} results\` to inspect setup logs.`,
    ],
    earlyExitCheckMs: EVAL_EARLY_EXIT_CHECK_MS,
    dataDirForNotifications: params.dataDir,
  });
}

async function handleManagedSuiteRun(params: {
  suite: EvalSuiteDefinition;
  dataDir: string;
  env: EvalEnvironment;
  channelId?: string;
  args: string[];
}): Promise<GatewayCommandResult> {
  if (!isManagedSuiteInstalled(params.suite, params.dataDir)) {
    return errorResult(
      `${params.suite.title} Setup Required`,
      `Run \`/eval ${params.suite.id} setup\` first.`,
    );
  }

  const prepared = prepareManagedSuiteRun(
    params.suite,
    params.dataDir,
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
    ],
    dataDirForNotifications: params.dataDir,
  });
}

async function handleManagedSuiteCommand(params: {
  suite: EvalSuiteDefinition;
  dataDir: string;
  env: EvalEnvironment;
  channelId?: string;
  subcommand?: string;
  args?: string[];
}): Promise<GatewayCommandResult> {
  const subcommand = String(params.subcommand || '')
    .trim()
    .toLowerCase();
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
        channelId: params.channelId,
        args: params.args || [],
      });
    case 'status':
      return infoResult(
        `${params.suite.title} Status`,
        renderManagedSuiteStatus(params.suite, params.dataDir),
      );
    case 'results':
      return renderManagedSuiteResults(params.suite, params.dataDir);
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
      if (
        managedSubcommand === 'setup' ||
        managedSubcommand === 'run' ||
        managedSubcommand === 'status' ||
        managedSubcommand === 'results'
      ) {
        return await handleManagedSuiteCommand({
          suite: managedSuite,
          dataDir: params.dataDir,
          env,
          channelId: params.channelId,
          subcommand: managedSubcommand,
          args: parsed.commandArgs.slice(2),
        });
      }
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
    channelId: params.channelId,
    subcommand: 'help',
  });
}
