/**
 * Native benchmark tasks share one admitted resource budget and cancellation scope.
 * This orchestrates task environments; gateway execution and shared-engine
 * maintenance remain outside the runner's ownership.
 */
import fs from 'node:fs';
import path from 'node:path';
import { stopSessionExecution } from '../../src/agent/executor.js';
import { handleGatewayMessage } from '../../src/gateway/gateway-chat-service.js';
import type { GatewayChatRequest } from '../../src/gateway/gateway-types.js';
import { benchmarkCommand } from './benchmark-command.js';
import {
  type BenchmarkBudget,
  BenchmarkResources,
  DEFAULT_BENCHMARK_BUDGET,
} from './benchmark-resources.js';

interface TerminalBenchTask {
  task_name: string;
  category?: string;
  instruction: string;
  docker_image?: string;
  environment_tar?: string;
  tests_tar?: string;
  test_sh?: string;
}

interface NativeRunnerOptions {
  installDir: string;
  dataDir: string;
  model: string;
  agentId: string;
  numTasks: number;
  concurrency: number;
  promptMode: 'full' | 'minimal' | 'none';
  includePromptParts: string[];
  omitPromptParts: string[];
  taskFilter: string[];
  budget: BenchmarkBudget;
}

interface TaskEnvironment {
  containerName: string;
  workspaceDir: string;
  testsDir: string;
  verifierDir: string;
  cleanup: () => Promise<void>;
}

interface TaskResultSummary {
  taskName: string;
  category: string;
  reward: number;
  passed: boolean;
  turnsUsed: number;
  finishedNaturally: boolean;
  error?: string;
}

const TERMINAL_BENCH_NATIVE_MAX_TOKENS = 16_384;

function parseArgs(argv: string[]): NativeRunnerOptions {
  let installDir = '';
  let dataDir = '';
  let model = '';
  let agentId = 'main';
  let numTasks = 1;
  let concurrency = 1;
  let promptMode: NativeRunnerOptions['promptMode'] = 'minimal';
  let includePromptParts: string[] = [];
  let omitPromptParts: string[] = [];
  let taskFilter: string[] = [];
  const budget = { ...DEFAULT_BENCHMARK_BUDGET };
  const budgetFlags: Record<string, keyof BenchmarkBudget> = {
    '--task-memory-gib': 'memoryGiB',
    '--task-swap-gib': 'swapGiB',
    '--task-disk-gib': 'diskGiB',
    '--artifact-disk-gib': 'artifactGiB',
  };
  argv = argv.flatMap((arg) => {
    const equals = arg.indexOf('=');
    return arg.startsWith('--') && equals !== -1
      ? [arg.slice(0, equals), arg.slice(equals + 1)]
      : [arg];
  });

  for (let i = 0; i < argv.length; i += 1) {
    const current = String(argv[i] || '').trim();
    if (!current) continue;
    const next = () => String(argv[i + 1] || '').trim();
    const budgetKey = Object.hasOwn(budgetFlags, current)
      ? budgetFlags[current]
      : undefined;
    if (budgetKey) {
      const value = Number(next());
      if (
        !next() ||
        !Number.isFinite(value) ||
        value < 0 ||
        (budgetKey !== 'swapGiB' && value === 0) ||
        !Number.isSafeInteger(Math.ceil(value * 1024 ** 3)) ||
        (budgetKey === 'memoryGiB' && value * 1024 ** 3 < 6 * 1024 ** 2)
      )
        throw new Error(`Invalid resource budget: ${current}`);
      budget[budgetKey] = value;
      i += 1;
      continue;
    }
    if (current === '--install-dir') {
      installDir = next();
      i += 1;
      continue;
    }
    if (current === '--data-dir') {
      dataDir = next();
      i += 1;
      continue;
    }
    if (current === '--model') {
      model = next();
      i += 1;
      continue;
    }
    if (current === '--agent-id') {
      agentId = next() || 'main';
      i += 1;
      continue;
    }
    if (current === '--num-tasks') {
      numTasks = Number(next());
      if (!Number.isSafeInteger(numTasks) || numTasks < 1)
        throw new Error('Invalid --num-tasks');
      i += 1;
      continue;
    }
    if (current === '--n-concurrent' || current === '-n') {
      concurrency = Number(next());
      if (!Number.isSafeInteger(concurrency) || concurrency < 1)
        throw new Error('Invalid --n-concurrent');
      i += 1;
      continue;
    }
    if (current === '--prompt-mode') {
      const value = next();
      if (value === 'full' || value === 'minimal' || value === 'none') {
        promptMode = value;
      }
      i += 1;
      continue;
    }
    if (current === '--include-prompt') {
      includePromptParts = next()
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);
      i += 1;
      continue;
    }
    if (current === '--omit-prompt') {
      omitPromptParts = next()
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);
      i += 1;
      continue;
    }
    if (current === '--task-filter') {
      taskFilter = next()
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);
      i += 1;
      continue;
    }
    throw new Error(`Unknown benchmark option: ${current}`);
  }

  if (!installDir) {
    throw new Error('Missing required `--install-dir`.');
  }
  if (!dataDir) {
    throw new Error('Missing required `--data-dir`.');
  }
  if (!model) {
    throw new Error('Missing required `--model`.');
  }

  return {
    installDir: path.resolve(installDir),
    dataDir: path.resolve(dataDir),
    model,
    agentId,
    numTasks,
    concurrency,
    promptMode,
    includePromptParts,
    omitPromptParts,
    taskFilter,
    budget,
  };
}

async function runCommand(
  params: Parameters<typeof benchmarkCommand>[0],
): Promise<string> {
  return (await benchmarkCommand(params)).stdout;
}

async function runDocker(
  args: string[],
  signal?: AbortSignal,
): Promise<string> {
  return runCommand({ command: 'docker', args, signal });
}

async function runDockerAllowFailure(args: string[], signal?: AbortSignal) {
  return benchmarkCommand({
    command: 'docker',
    args,
    signal,
    allowFailure: true,
  });
}

function sanitizeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
}

function readDatasetHelperPath(installDir: string): string {
  return path.join(installDir, 'hybridclaw_terminal_bench_dataset.py');
}

async function loadTasks(
  options: NativeRunnerOptions,
  signal: AbortSignal,
): Promise<TerminalBenchTask[]> {
  const pythonPath =
    process.platform === 'win32'
      ? path.join(options.installDir, '.venv', 'Scripts', 'python.exe')
      : path.join(options.installDir, '.venv', 'bin', 'python');
  const helperPath = readDatasetHelperPath(options.installDir);
  const output = await runCommand({
    command: pythonPath,
    signal,
    args: [
      helperPath,
      'list',
      '--num-tasks',
      String(options.numTasks),
      ...(options.taskFilter.length > 0
        ? ['--task-filter', options.taskFilter.join(',')]
        : []),
    ],
  });
  const parsed = JSON.parse(output) as TerminalBenchTask[];
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    parsed.length > options.numTasks
  ) {
    throw new Error(
      'Terminal-Bench dataset helper returned an invalid task count.',
    );
  }
  return parsed;
}

async function writeBase64TarToDirectory(
  encoded: string,
  targetDir: string,
  signal: AbortSignal,
): Promise<void> {
  if (!encoded.trim()) return;
  fs.mkdirSync(targetDir, { recursive: true });
  const python = process.platform === 'win32' ? 'py' : 'python3';
  await runCommand({
    command: python,
    signal,
    args: [
      '-c',
      [
        'import base64, io, sys, tarfile',
        'payload = sys.stdin.buffer.read()',
        'target = sys.argv[1]',
        'raw = base64.b64decode(payload)',
        "with tarfile.open(fileobj=io.BytesIO(raw), mode='r:gz') as tar:",
        '    tar.extractall(target)',
      ].join('\n'),
      targetDir,
    ],
    input: encoded,
  });
}

async function buildDockerImageForTask(
  task: TerminalBenchTask,
  taskDir: string,
  signal: AbortSignal,
): Promise<string> {
  if (task.docker_image?.trim()) return task.docker_image.trim();
  const environmentTar = String(task.environment_tar || '').trim();
  if (!environmentTar) {
    throw new Error(
      `Task ${task.task_name} has neither docker_image nor environment_tar.`,
    );
  }
  const buildDir = path.join(taskDir, 'environment');
  await writeBase64TarToDirectory(environmentTar, buildDir, signal);
  const tag = `hybridclaw-tb2-${sanitizeName(task.task_name)}-${Date.now().toString(36)}`;
  await runDocker(['build', '-t', tag, buildDir], signal);
  return tag;
}

async function startTaskEnvironment(
  task: TerminalBenchTask,
  jobDir: string,
  resources: BenchmarkResources,
): Promise<TaskEnvironment> {
  const taskRoot = path.join(jobDir, sanitizeName(task.task_name));
  const workspaceDir = path.join(taskRoot, 'workspace');
  const testsDir = path.join(taskRoot, 'tests');
  const verifierDir = path.join(taskRoot, 'verifier');
  fs.mkdirSync(taskRoot, { recursive: true });
  fs.mkdirSync(testsDir, { recursive: true });
  fs.mkdirSync(verifierDir, { recursive: true });

  const image = await buildDockerImageForTask(task, taskRoot, resources.signal);
  await resources.check(1, 1);
  fs.mkdirSync(workspaceDir, { recursive: true });

  const containerName = `hybridclaw-tb2-${sanitizeName(task.task_name)}-${Date.now().toString(36)}`;
  const cleanup = async () => {
    await benchmarkCommand({
      command: 'docker',
      args: ['rm', '-f', containerName],
      timeout: 10_000,
      allowFailure: true,
    });
  };
  try {
    await runDocker(
      [
        'run',
        '-d',
        '--rm',
        '--name',
        containerName,
        '--memory',
        String(Math.ceil(resources.budget.memoryGiB * 1024 ** 3)),
        '--memory-swap',
        String(
          Math.ceil(
            (resources.budget.memoryGiB + resources.budget.swapGiB) * 1024 ** 3,
          ),
        ),
        '-w',
        '/app',
        '--entrypoint',
        'sh',
        image,
        '-lc',
        'while true; do sleep 3600; done',
      ],
      resources.signal,
    );
  } catch (error) {
    await cleanup();
    throw error;
  }

  return {
    containerName,
    workspaceDir,
    testsDir,
    verifierDir,
    cleanup,
  };
}

async function prepareVerifierFiles(
  task: TerminalBenchTask,
  env: TaskEnvironment,
  signal: AbortSignal,
): Promise<void> {
  const testsTar = String(task.tests_tar || '').trim();
  if (testsTar) {
    await writeBase64TarToDirectory(testsTar, env.testsDir, signal);
  }
  const testSh = String(task.test_sh || '').trim();
  if (testSh) {
    fs.writeFileSync(
      path.join(env.testsDir, 'test.sh'),
      `${testSh}\n`,
      'utf-8',
    );
  }
  await runDocker(
    [
      'exec',
      '-i',
      env.containerName,
      'bash',
      '-lc',
      'mkdir -p /tests /logs/verifier',
    ],
    signal,
  );
  const copyResult = await runDockerAllowFailure(
    ['cp', `${env.testsDir}${path.sep}.`, `${env.containerName}:/tests`],
    signal,
  );
  if (copyResult.status !== 0) {
    const detail = [copyResult.stdout, copyResult.stderr]
      .filter(Boolean)
      .join('\n')
      .trim();
    throw new Error(detail || 'Failed to copy Terminal-Bench verifier files');
  }
}

async function snapshotContainerDirectory(
  containerName: string,
  remotePath: string,
  targetDir: string,
  signal: AbortSignal,
): Promise<void> {
  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.mkdirSync(targetDir, { recursive: true });
  const result = await runDockerAllowFailure(
    [
      'cp',
      `${containerName}:${remotePath}${remotePath.endsWith('/') ? '.' : '/.'}`,
      targetDir,
    ],
    signal,
  );
  if (result.status === 0) return;
  const detail = [result.stdout, result.stderr].filter(Boolean).join('\n');
  if (/no such file|could not find/i.test(detail)) return;
  throw new Error(detail.trim() || `Failed to copy ${remotePath}`);
}

async function runVerifier(
  task: TerminalBenchTask,
  env: TaskEnvironment,
  signal: AbortSignal,
): Promise<number> {
  await prepareVerifierFiles(task, env, signal);
  const testRun = await runDockerAllowFailure(
    ['exec', '-i', '-w', '/app', env.containerName, 'bash', '/tests/test.sh'],
    signal,
  );
  await snapshotContainerDirectory(
    env.containerName,
    '/logs/verifier',
    env.verifierDir,
    signal,
  );
  const rewardPath = path.join(env.verifierDir, 'reward.txt');
  const rewardText = fs.existsSync(rewardPath)
    ? fs.readFileSync(rewardPath, 'utf-8').trim()
    : '';
  if (rewardText === '1') return 1;
  if (rewardText === '0') return 0;
  const parsed = Number.parseFloat(rewardText);
  if (Number.isFinite(parsed)) return parsed;
  if (testRun.status === 0) return 1;
  return 0;
}

async function runTask(
  task: TerminalBenchTask,
  options: NativeRunnerOptions,
  jobDir: string,
  resources: BenchmarkResources,
): Promise<TaskResultSummary> {
  let env: TaskEnvironment | undefined;
  const sessionId = `tb2:${sanitizeName(task.task_name)}:${Date.now().toString(36)}`;
  const executionSessionId = `tb2-exec:${sanitizeName(task.task_name)}:${Date.now().toString(36)}`;
  const taskDir = path.join(jobDir, sanitizeName(task.task_name));
  const stop = () => {
    stopSessionExecution(executionSessionId);
    stopSessionExecution(sessionId);
    void env?.cleanup();
  };
  resources.signal.addEventListener('abort', stop, { once: true });
  try {
    resources.signal.throwIfAborted();
    env = await startTaskEnvironment(task, jobDir, resources);
    resources.signal.throwIfAborted();
    const promptPath = path.join(taskDir, 'prompt.txt');
    fs.writeFileSync(
      promptPath,
      String(task.instruction || '').trim(),
      'utf-8',
    );
    const request: GatewayChatRequest = {
      sessionId,
      executionSessionId,
      executorModeOverride: 'host',
      autoApproveTools: true,
      workspacePathOverride: env.workspaceDir,
      workspaceDisplayRootOverride: '/app',
      bashProxy: {
        mode: 'docker-exec',
        containerName: env.containerName,
        cwd: '/app',
      },
      guildId: null,
      channelId: 'eval-terminal-bench-native',
      userId: 'terminal-bench-native',
      username: 'terminal-bench-native',
      content: String(task.instruction || '').trim(),
      agentId: options.agentId,
      model: options.model,
      maxTokens: TERMINAL_BENCH_NATIVE_MAX_TOKENS,
      maxWallClockMs: null,
      inactivityTimeoutMs: null,
      promptMode: options.promptMode,
      includePromptParts:
        options.includePromptParts.length > 0
          ? (options.includePromptParts as GatewayChatRequest['includePromptParts'])
          : undefined,
      omitPromptParts:
        options.omitPromptParts.length > 0
          ? (options.omitPromptParts as GatewayChatRequest['omitPromptParts'])
          : undefined,
      source: 'eval.terminal-bench.native',
    };

    const result = await handleGatewayMessage(request);
    fs.writeFileSync(
      path.join(taskDir, 'agent-result.json'),
      `${JSON.stringify(result, null, 2)}\n`,
      'utf-8',
    );
    resources.signal.throwIfAborted();
    await snapshotContainerDirectory(
      env.containerName,
      '/app',
      env.workspaceDir,
      resources.signal,
    );
    const reward = await runVerifier(task, env, resources.signal);
    await resources.check(0, 0);
    const summary: TaskResultSummary = {
      taskName: task.task_name,
      category: String(task.category || 'unknown'),
      reward,
      passed: reward === 1,
      turnsUsed: 0,
      finishedNaturally: true,
      ...(result.status === 'error' && result.error
        ? { error: result.error }
        : {}),
    };
    const payload = result as {
      toolExecutions?: unknown[];
    };
    const agentResultFile = path.join(taskDir, 'summary.json');
    fs.writeFileSync(
      agentResultFile,
      `${JSON.stringify(
        {
          ...summary,
          toolExecutions: payload.toolExecutions || [],
        },
        null,
        2,
      )}\n`,
      'utf-8',
    );
    return summary;
  } finally {
    stopSessionExecution(executionSessionId);
    stopSessionExecution(sessionId);
    resources.signal.removeEventListener('abort', stop);
    await env?.cleanup();
  }
}

async function mapLimit<T, R>(
  values: T[],
  limit: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(values[index], index);
    }
  }
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, values.length)) }, () =>
      worker(),
    ),
  );
  return results;
}

export async function runTerminalBenchNativeCli(argv: string[]): Promise<void> {
  const options = parseArgs(argv);
  const jobsRoot = path.join(options.installDir, 'jobs');
  const jobId = new Date().toISOString().replace(/[:.]/g, '-');
  const jobDir = path.join(jobsRoot, jobId);
  fs.mkdirSync(jobDir, { recursive: true });
  console.log(`Job dir: ${jobDir}`);
  // Admission precedes dataset download/extraction, builds and task image pulls.
  const resources = new BenchmarkResources(
    [options.installDir, options.dataDir],
    options.budget,
    (snapshot) => {
      const line = JSON.stringify({
        at: new Date().toISOString(),
        ...snapshot,
      });
      fs.appendFileSync(path.join(jobDir, 'resources.jsonl'), `${line}\n`);
      console.log(`RESOURCE ${line}`);
    },
  );
  const interrupt = () => resources.abort(new Error('Benchmark interrupted'));
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    await resources.start(
      Math.min(options.concurrency, options.numTasks),
      options.numTasks,
    );
    const tasks = await loadTasks(options, resources.signal);
    console.log('Terminal-Bench 2.0 Native Run');
    console.log(`Job dir: ${jobDir}`);
    console.log(`Agent: ${options.agentId}`);
    console.log(`Model: ${options.model}`);
    console.log(`Prompt mode: ${options.promptMode}`);
    console.log(`Tasks: ${tasks.length}`);
    console.log(`Concurrency: ${options.concurrency}`);
    console.log('');

    let infrastructureError: string | undefined;
    const summaries = await mapLimit(
      tasks,
      options.concurrency,
      async (task, index) => {
        console.log(`[${index + 1}/${tasks.length}] START ${task.task_name}`);
        const startedAt = Date.now();
        try {
          resources.signal.throwIfAborted();
          await resources.check(1, 1);
          const summary = await runTask(task, options, jobDir, resources);
          const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(0);
          console.log(
            `[${index + 1}/${tasks.length}] ${summary.passed ? 'PASS' : 'FAIL'} ${task.task_name} reward=${summary.reward.toFixed(3)} ${elapsedSeconds}s`,
          );
          return summary;
        } catch (error) {
          await resources.check(0, 0).catch(() => {});
          const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(0);
          const message =
            error instanceof Error ? error.message : String(error);
          if (resources.signal.aborted)
            infrastructureError = String(resources.signal.reason);
          console.log(
            `[${index + 1}/${tasks.length}] ERROR ${task.task_name} ${elapsedSeconds}s ${message}`,
          );
          return {
            taskName: task.task_name,
            category: String(task.category || 'unknown'),
            reward: 0,
            passed: false,
            turnsUsed: 0,
            finishedNaturally: false,
            error: message,
          } satisfies TaskResultSummary;
        }
      },
    );

    await resources.check(0, 0).catch(() => {});
    if (resources.signal.aborted)
      infrastructureError = String(resources.signal.reason);
    const trials = summaries.length;
    const errors = summaries.filter(
      (summary) => summary.passed !== true && Boolean(summary.error),
    ).length;
    const mean =
      trials > 0
        ? summaries.reduce((sum, summary) => sum + summary.reward, 0) / trials
        : 0;
    const rewardCounts = new Map<string, number>();
    for (const summary of summaries) {
      const key = summary.reward.toFixed(1);
      rewardCounts.set(key, (rewardCounts.get(key) || 0) + 1);
    }

    const resultPayload = {
      agent: options.agentId,
      dataset: 'terminal-bench',
      infrastructureError,
      resourceBudget: options.budget,
      trials,
      errors,
      mean: infrastructureError ? null : mean,
      rewards: summaries,
    };
    fs.writeFileSync(
      path.join(jobDir, 'result.json'),
      `${JSON.stringify(resultPayload, null, 2)}\n`,
      'utf-8',
    );

    if (infrastructureError) throw new Error(infrastructureError);

    console.log('         hybridclaw on terminal-bench');
    console.log('┏━━━━━━━━━━━━━━━━━━━━━┳━━━━━━━━━━━━━━━━┓');
    console.log('┃ Metric              ┃ Value          ┃');
    console.log('┡━━━━━━━━━━━━━━━━━━━━━╇━━━━━━━━━━━━━━━━┩');
    console.log(`│ Agent               │ ${options.agentId.padEnd(14)} │`);
    console.log('│ Dataset             │ terminal-bench │');
    console.log(`│ Trials              │ ${String(trials).padEnd(14)} │`);
    console.log(`│ Errors              │ ${String(errors).padEnd(14)} │`);
    console.log('│                     │                │');
    console.log(`│ Mean                │ ${mean.toFixed(3).padEnd(14)} │`);
    console.log('│                     │                │');
    console.log('│ Reward Distribution │                │');
    for (const [reward, count] of [...rewardCounts.entries()].sort()) {
      console.log(
        `│   reward = ${reward}      │ ${String(count).padEnd(14)} │`,
      );
    }
    console.log('└─────────────────────┴────────────────┘');
    console.log(`Results written to ${path.join(jobDir, 'result.json')}`);
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    await resources.close();
  }
}
