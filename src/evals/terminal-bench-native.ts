import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { stopSessionExecution } from '../agent/executor.js';
import { handleGatewayMessage } from '../gateway/gateway-chat-service.js';
import type { GatewayChatRequest } from '../gateway/gateway-types.js';

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
}

interface TaskEnvironment {
  containerName: string;
  workspaceDir: string;
  testsDir: string;
  verifierDir: string;
  cleanup: () => void;
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

  for (let i = 0; i < argv.length; i += 1) {
    const current = String(argv[i] || '').trim();
    if (!current) continue;
    const next = () => String(argv[i + 1] || '').trim();
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
      numTasks = Math.max(1, Number.parseInt(next() || '1', 10) || 1);
      i += 1;
      continue;
    }
    if (current === '--n-concurrent') {
      concurrency = Math.max(1, Number.parseInt(next() || '1', 10) || 1);
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
    }
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
  };
}

function runCommand(params: {
  command: string;
  args: string[];
  cwd?: string;
  input?: string;
}): string {
  const result = spawnSync(params.command, params.args, {
    cwd: params.cwd,
    encoding: 'utf-8',
    input: params.input,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status === 0) return result.stdout || '';
  const detail = [result.stdout, result.stderr]
    .filter(Boolean)
    .join('\n')
    .trim();
  throw new Error(
    detail ||
      `${params.command} exited with code ${result.status ?? 'unknown'}`,
  );
}

function runDocker(args: string[], cwd?: string): string {
  return runCommand({
    command: 'docker',
    args,
    cwd,
  });
}

function runDockerAllowFailure(
  args: string[],
  cwd?: string,
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('docker', args, {
    cwd,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: typeof result.status === 'number' ? result.status : null,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function sanitizeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
}

function readDatasetHelperPath(installDir: string): string {
  return path.join(installDir, 'hybridclaw_terminal_bench_dataset.py');
}

function loadTasks(options: NativeRunnerOptions): TerminalBenchTask[] {
  const pythonPath =
    process.platform === 'win32'
      ? path.join(options.installDir, '.venv', 'Scripts', 'python.exe')
      : path.join(options.installDir, '.venv', 'bin', 'python');
  const helperPath = readDatasetHelperPath(options.installDir);
  const output = runCommand({
    command: pythonPath,
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
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('Terminal-Bench dataset helper returned no tasks.');
  }
  return parsed;
}

function writeBase64TarToDirectory(encoded: string, targetDir: string): void {
  if (!encoded.trim()) return;
  fs.mkdirSync(targetDir, { recursive: true });
  const python = process.platform === 'win32' ? 'py' : 'python3';
  runCommand({
    command: python,
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

function buildDockerImageForTask(
  task: TerminalBenchTask,
  taskDir: string,
): string {
  if (task.docker_image?.trim()) return task.docker_image.trim();
  const environmentTar = String(task.environment_tar || '').trim();
  if (!environmentTar) {
    throw new Error(
      `Task ${task.task_name} has neither docker_image nor environment_tar.`,
    );
  }
  const buildDir = path.join(taskDir, 'environment');
  writeBase64TarToDirectory(environmentTar, buildDir);
  const tag = `hybridclaw-tb2-${sanitizeName(task.task_name)}-${Date.now().toString(36)}`;
  runDocker(['build', '-t', tag, buildDir]);
  return tag;
}

function startTaskEnvironment(
  task: TerminalBenchTask,
  jobDir: string,
): TaskEnvironment {
  const taskRoot = path.join(jobDir, sanitizeName(task.task_name));
  const workspaceDir = path.join(taskRoot, 'workspace');
  const testsDir = path.join(taskRoot, 'tests');
  const verifierDir = path.join(taskRoot, 'verifier');
  fs.mkdirSync(taskRoot, { recursive: true });
  fs.mkdirSync(testsDir, { recursive: true });
  fs.mkdirSync(verifierDir, { recursive: true });

  const image = buildDockerImageForTask(task, taskRoot);
  fs.mkdirSync(workspaceDir, { recursive: true });

  const containerName = `hybridclaw-tb2-${sanitizeName(task.task_name)}-${Date.now().toString(36)}`;
  runDocker([
    'run',
    '-d',
    '--rm',
    '--name',
    containerName,
    '-w',
    '/app',
    '--entrypoint',
    'sh',
    image,
    '-lc',
    'while true; do sleep 3600; done',
  ]);

  return {
    containerName,
    workspaceDir,
    testsDir,
    verifierDir,
    cleanup: () => {
      try {
        runDocker(['rm', '-f', containerName]);
      } catch {
        // best effort
      }
    },
  };
}

function prepareVerifierFiles(
  task: TerminalBenchTask,
  env: TaskEnvironment,
): void {
  const testsTar = String(task.tests_tar || '').trim();
  if (testsTar) {
    writeBase64TarToDirectory(testsTar, env.testsDir);
  }
  const testSh = String(task.test_sh || '').trim();
  if (testSh) {
    fs.writeFileSync(
      path.join(env.testsDir, 'test.sh'),
      `${testSh}\n`,
      'utf-8',
    );
  }
  runDocker([
    'exec',
    '-i',
    env.containerName,
    'bash',
    '-lc',
    'mkdir -p /tests /logs/verifier',
  ]);
  const copyResult = runDockerAllowFailure([
    'cp',
    `${env.testsDir}${path.sep}.`,
    `${env.containerName}:/tests`,
  ]);
  if (copyResult.status !== 0) {
    const detail = [copyResult.stdout, copyResult.stderr]
      .filter(Boolean)
      .join('\n')
      .trim();
    throw new Error(detail || 'Failed to copy Terminal-Bench verifier files');
  }
}

function snapshotContainerDirectory(
  containerName: string,
  remotePath: string,
  targetDir: string,
): void {
  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.mkdirSync(targetDir, { recursive: true });
  const result = runDockerAllowFailure([
    'cp',
    `${containerName}:${remotePath}${remotePath.endsWith('/') ? '.' : '/.'}`,
    targetDir,
  ]);
  if (result.status === 0) return;
  const detail = [result.stdout, result.stderr].filter(Boolean).join('\n');
  if (/no such file|could not find/i.test(detail)) return;
  throw new Error(detail.trim() || `Failed to copy ${remotePath}`);
}

function runVerifier(task: TerminalBenchTask, env: TaskEnvironment): number {
  prepareVerifierFiles(task, env);
  const testRun = runDockerAllowFailure([
    'exec',
    '-i',
    '-w',
    '/app',
    env.containerName,
    'bash',
    '/tests/test.sh',
  ]);
  snapshotContainerDirectory(
    env.containerName,
    '/logs/verifier',
    env.verifierDir,
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
): Promise<TaskResultSummary> {
  const env = startTaskEnvironment(task, jobDir);
  const sessionId = `tb2:${sanitizeName(task.task_name)}:${Date.now().toString(36)}`;
  const executionSessionId = `tb2-exec:${sanitizeName(task.task_name)}:${Date.now().toString(36)}`;
  const taskDir = path.join(jobDir, sanitizeName(task.task_name));
  try {
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
      neverAutoApproveTools: [],
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
    snapshotContainerDirectory(env.containerName, '/app', env.workspaceDir);
    const reward = runVerifier(task, env);
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
    env.cleanup();
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
  const tasks = loadTasks(options);
  const jobsRoot = path.join(options.installDir, 'jobs');
  fs.mkdirSync(jobsRoot, { recursive: true });
  const jobId = new Date().toISOString().replace(/[:.]/g, '-');
  const jobDir = path.join(jobsRoot, jobId);
  fs.mkdirSync(jobDir, { recursive: true });

  console.log('Terminal-Bench 2.0 Native Run');
  console.log(`Job dir: ${jobDir}`);
  console.log(`Agent: ${options.agentId}`);
  console.log(`Model: ${options.model}`);
  console.log(`Prompt mode: ${options.promptMode}`);
  console.log(`Tasks: ${tasks.length}`);
  console.log(`Concurrency: ${options.concurrency}`);
  console.log('');

  const summaries = await mapLimit(
    tasks,
    options.concurrency,
    async (task, index) => {
      console.log(`[${index + 1}/${tasks.length}] START ${task.task_name}`);
      const startedAt = Date.now();
      try {
        const summary = await runTask(task, options, jobDir);
        const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(0);
        console.log(
          `[${index + 1}/${tasks.length}] ${summary.passed ? 'PASS' : 'FAIL'} ${task.task_name} reward=${summary.reward.toFixed(3)} ${elapsedSeconds}s`,
        );
        return summary;
      } catch (error) {
        const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(0);
        const message = error instanceof Error ? error.message : String(error);
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
    trials,
    errors,
    mean,
    rewards: summaries,
  };
  fs.writeFileSync(
    path.join(jobDir, 'result.json'),
    `${JSON.stringify(resultPayload, null, 2)}\n`,
    'utf-8',
  );

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
    console.log(`│   reward = ${reward}      │ ${String(count).padEnd(14)} │`);
  }
  console.log('└─────────────────────┴────────────────┘');
  console.log(`Results written to ${path.join(jobDir, 'result.json')}`);
}
