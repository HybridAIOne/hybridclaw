import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

const spawnMock = vi.fn();
const spawnSyncMock = vi.fn(() => ({ status: 0 }));
const isContainerMaxConcurrentExplicitMock = vi.fn(() => false);
const maxConcurrentContainersState = { value: 5 };
const originalHome = process.env.HOME;
const originalHybridClawHome = process.env.HYBRIDCLAW_HOME;
const originalProcessKill = process.kill;

vi.mock('../src/config/config.ts', async () => {
  const actual = await vi.importActual('../src/config/config.ts');
  return {
    ...actual,
    get MAX_CONCURRENT_CONTAINERS() {
      return maxConcurrentContainersState.value;
    },
  };
});

vi.mock('../src/config/runtime-config.ts', async () => {
  const actual = await vi.importActual('../src/config/runtime-config.ts');
  return {
    ...actual,
    isContainerMaxConcurrentExplicit: isContainerMaxConcurrentExplicitMock,
  };
});

vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
  spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
}));

afterEach(() => {
  spawnMock.mockReset();
  spawnSyncMock.mockClear();
  isContainerMaxConcurrentExplicitMock.mockReset();
  isContainerMaxConcurrentExplicitMock.mockReturnValue(false);
  maxConcurrentContainersState.value = 5;
  vi.resetModules();
  process.kill = originalProcessKill;
  if (originalHome == null) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  if (originalHybridClawHome == null) {
    delete process.env.HYBRIDCLAW_HOME;
  } else {
    process.env.HYBRIDCLAW_HOME = originalHybridClawHome;
  }
});

function installTau2Layout(dataDir: string): void {
  const installDir = path.join(dataDir, 'evals', 'tau2-bench');
  fs.mkdirSync(path.join(installDir, '.git'), { recursive: true });
  if (process.platform === 'win32') {
    fs.mkdirSync(path.join(installDir, '.venv', 'Scripts'), {
      recursive: true,
    });
    fs.writeFileSync(path.join(installDir, '.venv', 'Scripts', 'tau2.exe'), '');
    fs.writeFileSync(
      path.join(installDir, '.venv', 'Scripts', 'python.exe'),
      '',
    );
    return;
  }
  fs.mkdirSync(path.join(installDir, '.venv', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(installDir, '.venv', 'bin', 'tau2'), '');
  fs.writeFileSync(path.join(installDir, '.venv', 'bin', 'python'), '');
}

test('returns suite stub info without exposing tokens', async () => {
  const { handleEvalCommand } = await import('../src/evals/eval-command.ts');

  const result = await handleEvalCommand({
    args: ['gaia'],
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-eval-')),
    gatewayBaseUrl: 'http://127.0.0.1:9090',
    webApiToken: 'secret-token',
    effectiveAgentId: 'charly',
    effectiveModel: 'openai-codex/gpt-5.4',
  });

  expect(result.kind).toBe('info');
  if (result.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${result.kind}`);
  }
  expect(result.title).toBe('GAIA');
  expect(result.text).toContain('Not implemented yet.');
  expect(result.text).toContain('OPENAI_BASE_URL=http://127.0.0.1:9090/v1');
  expect(result.text).toContain('WEB_API_TOKEN injected automatically');
  expect(result.text).toContain(
    'HYBRIDCLAW_EVAL_MODEL=openai-codex/gpt-5.4__hc_eval=agent=charly',
  );
  expect(result.text).toContain(
    'Agent setup: current agent workspace (charly)',
  );
  expect(result.text).toContain(
    'Session state: fresh transient OpenAI-compatible session per request',
  );
  expect(result.text).not.toContain('secret-token');
});

test('starts detached eval runs with injected OpenAI-compatible env', async () => {
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-eval-run-'),
  );
  spawnMock.mockReturnValue({
    pid: 4321,
    unref: vi.fn(),
  });

  const { handleEvalCommand } = await import('../src/evals/eval-command.ts');
  const result = await handleEvalCommand({
    args: ['python', '-m', 'swebench.harness.run_evaluation'],
    dataDir,
    gatewayBaseUrl: 'http://127.0.0.1:9090',
    webApiToken: '',
    effectiveAgentId: 'main',
    effectiveModel: 'hybridai/gpt-4.1-mini',
  });

  expect(result.kind).toBe('info');
  if (result.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${result.kind}`);
  }
  expect(result.title).toBe('Eval Started');
  expect(result.text).toContain('PID: 4321');
  expect(result.text).toContain('Base URL: http://127.0.0.1:9090/v1');
  expect(result.text).toContain('loopback auth');

  expect(spawnMock).toHaveBeenCalledTimes(1);
  const [, , options] = spawnMock.mock.calls[0] as [
    string,
    string[],
    {
      cwd: string;
      detached: boolean;
      env: Record<string, string>;
    },
  ];
  expect(options.detached).toBe(true);
  expect(options.env.OPENAI_BASE_URL).toBe('http://127.0.0.1:9090/v1');
  expect(options.env.OPENAI_API_KEY).toBe('hybridclaw-local');
  expect(options.env.HYBRIDCLAW_EVAL_MODEL).toBe('hybridai/gpt-4.1-mini');

  const evalDir = path.join(dataDir, 'evals');
  const runDirs = fs.readdirSync(evalDir);
  expect(runDirs.length).toBe(1);
  const meta = JSON.parse(
    fs.readFileSync(path.join(evalDir, runDirs[0], 'run.json'), 'utf-8'),
  ) as {
    pid: number;
    authMode: string;
    openaiBaseUrl: string;
    model: string;
    command: string;
  };
  expect(meta.pid).toBe(4321);
  expect(meta.authMode).toBe('loopback');
  expect(meta.openaiBaseUrl).toBe('http://127.0.0.1:9090/v1');
  expect(meta.model).toBe('hybridai/gpt-4.1-mini');
  expect(meta.command).toBe('python -m swebench.harness.run_evaluation');
});

test('shows managed tau2 usage', async () => {
  const { handleEvalCommand } = await import('../src/evals/eval-command.ts');

  const result = await handleEvalCommand({
    args: ['tau2'],
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-eval-')),
    gatewayBaseUrl: 'http://127.0.0.1:9090',
    webApiToken: '',
    effectiveAgentId: 'main',
    effectiveModel: 'hybridai/gpt-4.1-mini',
  });

  expect(result.kind).toBe('info');
  if (result.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${result.kind}`);
  }
  expect(result.title).toBe('tau2');
  expect(result.text).toContain('/eval tau2 setup');
  expect(result.text).toContain(
    '/eval tau2 run --domain telecom --num-trials 1 --num-tasks 10',
  );
});

test('starts detached tau2 setup', async () => {
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-eval-run-'),
  );
  spawnMock.mockReturnValue({
    pid: 6789,
    unref: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  });

  const { handleEvalCommand } = await import('../src/evals/eval-command.ts');
  const result = await handleEvalCommand({
    args: ['tau2', 'setup'],
    dataDir,
    gatewayBaseUrl: 'http://127.0.0.1:9090',
    webApiToken: '',
    effectiveAgentId: 'main',
    effectiveModel: 'hybridai/gpt-4.1-mini',
  });

  expect(result.kind).toBe('info');
  if (result.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${result.kind}`);
  }
  expect(result.title).toBe('tau2 Setup Started');
  expect(result.text).toContain('Command: tau2 setup');
  expect(result.text).toContain('Detached setup job started.');
  expect(result.text).toContain(
    'Setup strategy: uv-managed Python 3.12 venv with tau2 CLI smoke test.',
  );
  expect(result.text).toContain('Use `/eval tau2 status`');
  expect(result.text).toContain('Use `/eval tau2 results`');

  const [, shellArgs] = spawnMock.mock.calls[0] as [string, string[]];
  expect(shellArgs[1]).toContain('git clone');
  expect(shellArgs[1]).toContain(
    'uv venv --seed --clear --managed-python --python 3.12 .venv',
  );
  expect(shellArgs[1]).toContain('uv pip install --python');
  expect(shellArgs[1]).toContain('.venv/bin/python\' -c "import tau2.cli"');
});

test('reports non-terminal suites as not implemented yet', async () => {
  const { handleEvalCommand } = await import('../src/evals/eval-command.ts');

  const result = await handleEvalCommand({
    args: ['swebench-verified', 'setup'],
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-eval-run-')),
    gatewayBaseUrl: 'http://127.0.0.1:9090',
    webApiToken: '',
    effectiveAgentId: 'main',
    effectiveModel: 'hybridai/gpt-4.1-mini',
  });

  expect(result.kind).toBe('error');
  expect(result.title).toBe('SWE-bench Verified');
  expect(result.text).toContain('SWE-bench Verified is not implemented yet.');
  expect(result.text).toContain('/eval terminal-bench-2.0');
  expect(result.text).toContain('/eval tau2');
  expect(spawnMock).not.toHaveBeenCalled();
});

test('starts detached terminal-bench setup', async () => {
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-eval-run-'),
  );
  const installDir = path.join(dataDir, 'evals', 'terminal-bench-2.0');
  spawnMock.mockReturnValue({
    pid: 6792,
    unref: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  });

  const { handleEvalCommand } = await import('../src/evals/eval-command.ts');
  const result = await handleEvalCommand({
    args: ['terminal-bench-2.0', 'setup'],
    dataDir,
    gatewayBaseUrl: 'http://127.0.0.1:9090',
    webApiToken: '',
    effectiveAgentId: 'main',
    effectiveModel: 'hybridai/gpt-4.1-mini',
  });

  expect(result.kind).toBe('info');
  if (result.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${result.kind}`);
  }
  expect(result.title).toBe('Terminal-Bench 2.0 Setup Started');
  expect(result.text).toContain('Command: terminal-bench-2.0 setup');
  expect(result.text).toContain(
    'Setup strategy: uv-managed Python 3.12 venv with Hugging Face datasets install and native Terminal-Bench helper smoke test.',
  );
  expect(result.text).toContain('Use `/eval terminal-bench-2.0 status`');
  expect(result.text).toContain('Use `/eval terminal-bench-2.0 results`');

  const [, shellArgs] = spawnMock.mock.calls[0] as [string, string[]];
  expect(shellArgs[1]).toContain('uv pip install --python');
  expect(shellArgs[1]).toContain('datasets');
  expect(shellArgs[1]).toContain('import hybridclaw_terminal_bench_dataset');
  const helperSource = fs.readFileSync(
    path.join(installDir, 'hybridclaw_terminal_bench_dataset.py'),
    'utf-8',
  );
  expect(helperSource).toContain('from datasets import load_dataset');
  expect(helperSource).toContain("list_parser.add_argument('--num-tasks'");
});

test('runs managed terminal-bench with native HybridClaw runner defaults', async () => {
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-eval-run-'),
  );
  const installDir = path.join(dataDir, 'evals', 'terminal-bench-2.0');
  fs.mkdirSync(path.join(installDir, '.venv', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(installDir, '.venv', 'bin', 'python'), '');
  fs.writeFileSync(path.join(installDir, '.hybridclaw-setup-ok'), '');
  spawnMock.mockReturnValue({
    pid: 6793,
    unref: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  });

  const { handleEvalCommand } = await import('../src/evals/eval-command.ts');
  const result = await handleEvalCommand({
    args: ['terminal-bench-2.0', 'run', '--num-tasks', '10'],
    dataDir,
    gatewayBaseUrl: 'http://127.0.0.1:9090',
    webApiToken: '',
    effectiveAgentId: 'main',
    effectiveModel: 'hybridai/gpt-4.1-mini',
  });

  expect(result.kind).toBe('info');
  if (result.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${result.kind}`);
  }
  expect(result.title).toBe('Terminal-Bench 2.0 Run Started');
  expect(result.text).toContain(
    'Command: terminal-bench-2.0 run --num-tasks 10',
  );
  expect(result.text).toContain(
    'Use `/eval terminal-bench-2.0 status` and `/eval terminal-bench-2.0 results` to follow this run.',
  );

  const [, shellArgs] = spawnMock.mock.calls[0] as [string, string[]];
  expect(shellArgs[1]).toContain('__eval-terminal-bench-native');
  expect(shellArgs[1]).toContain('--install-dir');
  expect(shellArgs[1]).toContain('--data-dir');
  expect(shellArgs[1]).toContain('--agent-id');
  expect(shellArgs[1]).toContain('main');
  expect(shellArgs[1]).toContain('--model');
  expect(shellArgs[1]).toContain('hybridai/gpt-4.1-mini');
  expect(shellArgs[1]).toContain('--prompt-mode');
  expect(shellArgs[1]).toContain('none');
  expect(shellArgs[1]).toContain('--num-tasks 10');
  expect(shellArgs[1]).toContain('--n-concurrent 1');
  expect(
    fs.readFileSync(
      path.join(installDir, 'hybridclaw_terminal_bench_dataset.py'),
      'utf-8',
    ),
  ).toContain('load_dataset');
});

test('caps managed terminal-bench concurrency at 4 when configured maxConcurrent leaves headroom', async () => {
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-eval-run-'),
  );
  const installDir = path.join(dataDir, 'evals', 'terminal-bench-2.0');
  fs.mkdirSync(path.join(installDir, '.venv', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(installDir, '.venv', 'bin', 'python'), '');
  fs.writeFileSync(path.join(installDir, '.hybridclaw-setup-ok'), '');
  spawnMock.mockReturnValue({
    pid: 6794,
    unref: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  });

  isContainerMaxConcurrentExplicitMock.mockReturnValue(true);

  const { handleEvalCommand } = await import('../src/evals/eval-command.ts');
  await handleEvalCommand({
    args: ['terminal-bench-2.0', 'run', '--num-tasks', '10'],
    dataDir,
    gatewayBaseUrl: 'http://127.0.0.1:9090',
    webApiToken: '',
    effectiveAgentId: 'main',
    effectiveModel: 'hybridai/gpt-4.1-mini',
  });

  const [, shellArgs] = spawnMock.mock.calls[0] as [string, string[]];
  expect(shellArgs[1]).toContain('--n-concurrent 4');
});

test('reserves one slot from configured terminal-bench concurrency defaults', async () => {
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-eval-run-'),
  );
  const installDir = path.join(dataDir, 'evals', 'terminal-bench-2.0');
  fs.mkdirSync(path.join(installDir, '.venv', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(installDir, '.venv', 'bin', 'python'), '');
  fs.writeFileSync(path.join(installDir, '.hybridclaw-setup-ok'), '');
  spawnMock.mockReturnValue({
    pid: 6796,
    unref: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  });

  isContainerMaxConcurrentExplicitMock.mockReturnValue(true);
  maxConcurrentContainersState.value = 3;

  const { handleEvalCommand } = await import('../src/evals/eval-command.ts');
  await handleEvalCommand({
    args: ['terminal-bench-2.0', 'run', '--num-tasks', '10'],
    dataDir,
    gatewayBaseUrl: 'http://127.0.0.1:9090',
    webApiToken: '',
    effectiveAgentId: 'main',
    effectiveModel: 'hybridai/gpt-4.1-mini',
  });

  const [, shellArgs] = spawnMock.mock.calls[0] as [string, string[]];
  expect(shellArgs[1]).toContain('--n-concurrent 2');
});

test('preserves explicit terminal-bench concurrency override', async () => {
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-eval-run-'),
  );
  const installDir = path.join(dataDir, 'evals', 'terminal-bench-2.0');
  fs.mkdirSync(path.join(installDir, '.venv', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(installDir, '.venv', 'bin', 'python'), '');
  fs.writeFileSync(path.join(installDir, '.hybridclaw-setup-ok'), '');
  spawnMock.mockReturnValue({
    pid: 6795,
    unref: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  });

  isContainerMaxConcurrentExplicitMock.mockReturnValue(true);

  const { handleEvalCommand } = await import('../src/evals/eval-command.ts');
  await handleEvalCommand({
    args: [
      'terminal-bench-2.0',
      'run',
      '--num-tasks',
      '10',
      '--n-concurrent',
      '2',
    ],
    dataDir,
    gatewayBaseUrl: 'http://127.0.0.1:9090',
    webApiToken: '',
    effectiveAgentId: 'main',
    effectiveModel: 'hybridai/gpt-4.1-mini',
  });

  const [, shellArgs] = spawnMock.mock.calls[0] as [string, string[]];
  expect(shellArgs[1]).toContain('--n-concurrent 2');
  expect(shellArgs[1]).not.toContain('--n-concurrent 4');
  expect(shellArgs[1]).not.toContain('--n-concurrent 1');
});

test('reports fast tau2 setup failures inline with the reason', async () => {
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-eval-run-'),
  );
  spawnMock.mockImplementation((_command, _args, options) => {
    const stderrFd = (options as { stdio: [string, number, number] }).stdio[2];
    fs.writeSync(
      stderrFd,
      "ERROR: Package 'tau2' requires a different Python: 3.14.3 not in '<3.14,>=3.12'\n",
    );
    return {
      pid: 6799,
      unref: vi.fn(),
      off: vi.fn(),
      on: (event: string, handler: (code: number, signal: null) => void) => {
        if (event === 'exit') {
          setTimeout(() => handler(1, null), 0);
        }
      },
    };
  });

  const { handleEvalCommand } = await import('../src/evals/eval-command.ts');
  const result = await handleEvalCommand({
    args: ['tau2', 'setup'],
    dataDir,
    gatewayBaseUrl: 'http://127.0.0.1:9090',
    webApiToken: '',
    effectiveAgentId: 'main',
    effectiveModel: 'hybridai/gpt-4.1-mini',
  });

  expect(result.kind).toBe('error');
  expect(result.title).toBe('tau2 Setup Failed');
  expect(result.text).toContain('requires a different Python');
});

test('reports gaia subcommands as not implemented yet', async () => {
  const { handleEvalCommand } = await import('../src/evals/eval-command.ts');
  const result = await handleEvalCommand({
    args: ['gaia', 'status'],
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-eval-run-')),
    gatewayBaseUrl: 'http://127.0.0.1:9090',
    webApiToken: '',
    effectiveAgentId: 'main',
    effectiveModel: 'hybridai/gpt-4.1-mini',
  });

  expect(result.kind).toBe('error');
  expect(result.title).toBe('GAIA');
  expect(result.text).toContain('GAIA is not implemented yet.');
});

test('rejects unknown suite prefixes instead of launching a raw eval command', async () => {
  const { handleEvalCommand } = await import('../src/evals/eval-command.ts');
  const result = await handleEvalCommand({
    args: ['termin'],
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-eval-run-')),
    gatewayBaseUrl: 'http://127.0.0.1:9090',
    webApiToken: '',
    effectiveAgentId: 'main',
    effectiveModel: 'hybridai/gpt-4.1-mini',
  });

  expect(result.kind).toBe('error');
  expect(result.title).toBe('Unknown Eval');
  expect(result.text).toContain('Unknown eval suite: `termin`.');
  expect(result.text).toContain('Did you mean `terminal-bench-2.0`?');
});

test('reports managed suite latest run in status output', async () => {
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-eval-run-'),
  );
  const installDir = path.join(dataDir, 'evals', 'terminal-bench-2.0');
  fs.mkdirSync(path.join(installDir, '.venv', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(installDir, '.venv', 'bin', 'python'), '');
  fs.writeFileSync(path.join(installDir, '.hybridclaw-setup-ok'), '');
  const runDir = path.join(dataDir, 'evals', 'eval-terminal-bench-run-abc123');
  fs.mkdirSync(runDir, { recursive: true });
  const jobDir = path.join(
    dataDir,
    'evals',
    'terminal-bench-2.0',
    'jobs',
    '2026-04-07T08-11-03-774Z',
  );
  fs.mkdirSync(jobDir, { recursive: true });
  fs.writeFileSync(
    path.join(jobDir, 'result.json'),
    JSON.stringify(
      {
        agent: 'main',
        dataset: 'terminal-bench',
        trials: 2,
        errors: 0,
        mean: 0,
        rewards: [
          { taskName: 'a', reward: 0, passed: false },
          { taskName: 'b', reward: 0, passed: false },
        ],
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(runDir, 'run.json'),
    JSON.stringify(
      {
        runId: 'eval-terminal-bench-run',
        suiteId: 'terminal-bench-2.0',
        operation: 'run',
        pid: 4450,
        startedAt: '2026-04-06T18:00:00.000Z',
        finishedAt: '2026-04-06T18:05:00.000Z',
        exitCode: 0,
        cwd: installDir,
        command:
          `${process.execPath} ${path.join(process.cwd(), 'dist', 'cli.js')} __eval-terminal-bench-native --install-dir ${installDir} --data-dir ${dataDir} --agent-id main --model hybridai/gpt-4.1-mini --prompt-mode none --num-tasks 10 --n-concurrent 1`,
        displayCommand: 'terminal-bench-2.0 run --num-tasks 10',
        openaiBaseUrl: 'http://127.0.0.1:9090/v1',
        model: 'hybridai/gpt-4.1-mini',
        baseModel: 'hybridai/gpt-4.1-mini',
        authMode: 'loopback',
        profile: {
          workspaceMode: 'current-agent',
          ablateSystemPrompt: false,
          includePromptParts: [],
          omitPromptParts: [],
        },
        stdoutPath: path.join(runDir, 'stdout.log'),
        stderrPath: path.join(runDir, 'stderr.log'),
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(runDir, 'stdout.log'),
    `Terminal-Bench 2.0 Native Run\nJob dir: ${jobDir}\nResults written to ${path.join(jobDir, 'result.json')}\n`,
  );
  fs.writeFileSync(path.join(runDir, 'stderr.log'), '');

  const { handleEvalCommand } = await import('../src/evals/eval-command.ts');
  const result = await handleEvalCommand({
    args: ['terminal-bench-2.0', 'status'],
    dataDir,
    gatewayBaseUrl: 'http://127.0.0.1:9090',
    webApiToken: '',
    effectiveAgentId: 'main',
    effectiveModel: 'hybridai/gpt-4.1-mini',
  });

  expect(result.kind).toBe('info');
  expect(result.text).toContain('Latest run: eval-terminal-bench-run (completed)');
  expect(result.text).toContain(
    'Command: terminal-bench-2.0 run --num-tasks 10',
  );
  expect(result.text).toContain(path.join('terminal-bench-2.0', '.venv', 'bin', 'python'));
  expect(result.text).toContain('Score: 0.000');
  expect(result.text).toContain('Trials: 2');
  expect(result.text).toContain('Passed: 0/2');
  expect(result.text).toContain('Errors: 0');
});

test('shows generic managed suite setup logs in results', async () => {
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-eval-run-'),
  );
  const runDir = path.join(
    dataDir,
    'evals',
    'eval-terminal-bench-setup-abc123',
  );
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'stdout.log'), 'installed datasets\n');
  fs.writeFileSync(path.join(runDir, 'stderr.log'), 'docker check pending\n');
  fs.writeFileSync(
    path.join(runDir, 'run.json'),
    JSON.stringify(
      {
        runId: 'eval-terminal-bench-setup',
        suiteId: 'terminal-bench-2.0',
        operation: 'setup',
        pid: 8889,
        startedAt: '2026-04-06T20:00:00.000Z',
        cwd: process.cwd(),
        command: 'terminal-bench-2.0 setup',
        displayCommand: 'terminal-bench-2.0 setup',
        openaiBaseUrl: 'http://127.0.0.1:9090/v1',
        model: 'hybridai/gpt-4.1-mini',
        baseModel: 'hybridai/gpt-4.1-mini',
        authMode: 'loopback',
        profile: {
          workspaceMode: 'current-agent',
          ablateSystemPrompt: false,
          includePromptParts: [],
          omitPromptParts: [],
        },
        stdoutPath: path.join(runDir, 'stdout.log'),
        stderrPath: path.join(runDir, 'stderr.log'),
      },
      null,
      2,
    ),
  );

  const { handleEvalCommand } = await import('../src/evals/eval-command.ts');
  const result = await handleEvalCommand({
    args: ['terminal-bench-2.0', 'results'],
    dataDir,
    gatewayBaseUrl: 'http://127.0.0.1:9090',
    webApiToken: '',
    effectiveAgentId: 'main',
    effectiveModel: 'hybridai/gpt-4.1-mini',
  });

  expect(result.kind).toBe('info');
  expect(result.text).toMatch(/Run ID\s+eval-terminal-bench-setup/);
  expect(result.text).toContain('Status           completed');
  expect(result.text).not.toContain('Stdout tail:');
  expect(result.text).not.toContain('installed datasets');
  expect(result.text).not.toContain('docker check pending');
});

test('shows managed suite run summary in results when a run exists', async () => {
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-eval-run-'),
  );
  const runDir = path.join(
    dataDir,
    'evals',
    'eval-terminal-bench-run-results-abc123',
  );
  fs.mkdirSync(runDir, { recursive: true });
  const jobDir = path.join(
    dataDir,
    'evals',
    'terminal-bench-2.0',
    'jobs',
    '2026-04-07T08-11-03-774Z',
  );
  fs.mkdirSync(jobDir, { recursive: true });
  fs.writeFileSync(
    path.join(jobDir, 'result.json'),
    JSON.stringify(
      {
        agent: 'main',
        dataset: 'terminal-bench',
        trials: 2,
        errors: 0,
        mean: 0.5,
        rewards: [
          { taskName: 'a', reward: 1, passed: true },
          { taskName: 'b', reward: 0, passed: false },
        ],
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(runDir, 'stdout.log'),
    `Terminal-Bench 2.0 Native Run\nJob dir: ${jobDir}\nResults written to ${path.join(jobDir, 'result.json')}\n`,
  );
  fs.writeFileSync(path.join(runDir, 'stderr.log'), 'docker warning\n');
  fs.writeFileSync(
    path.join(runDir, 'run.json'),
    JSON.stringify(
      {
        runId: 'eval-terminal-bench-run-results',
        suiteId: 'terminal-bench-2.0',
        operation: 'run',
        pid: 8890,
        startedAt: '2026-04-06T20:00:00.000Z',
        finishedAt: '2026-04-06T20:05:00.000Z',
        cwd: process.cwd(),
        command:
          `${process.execPath} ${path.join(process.cwd(), 'dist', 'cli.js')} __eval-terminal-bench-native --install-dir ${path.join(dataDir, 'evals', 'terminal-bench-2.0')} --data-dir ${dataDir} --agent-id main --model hybridai/gpt-4.1-mini --prompt-mode none --num-tasks 10 --n-concurrent 1`,
        displayCommand: 'terminal-bench-2.0 run --num-tasks 10',
        openaiBaseUrl: 'http://127.0.0.1:9090/v1',
        model: 'hybridai/gpt-4.1-mini',
        baseModel: 'hybridai/gpt-4.1-mini',
        authMode: 'loopback',
        profile: {
          workspaceMode: 'current-agent',
          ablateSystemPrompt: false,
          includePromptParts: [],
          omitPromptParts: [],
        },
        stdoutPath: path.join(runDir, 'stdout.log'),
        stderrPath: path.join(runDir, 'stderr.log'),
      },
      null,
      2,
    ),
  );

  const { handleEvalCommand } = await import('../src/evals/eval-command.ts');
  const result = await handleEvalCommand({
    args: ['terminal-bench-2.0', 'results'],
    dataDir,
    gatewayBaseUrl: 'http://127.0.0.1:9090',
    webApiToken: '',
    effectiveAgentId: 'main',
    effectiveModel: 'hybridai/gpt-4.1-mini',
  });

  expect(result.kind).toBe('info');
  expect(result.text).toContain('Evaluated model  hybridai/gpt-4.1-mini');
  expect(result.text).toContain('Harness          HybridClaw v0.11.0');
  expect(result.text).toContain('Overview');
  expect(result.text).toContain('Results');
  expect(result.text).toContain('Run');
  expect(result.text).toContain('Paths');
  expect(result.text).toContain('Status           completed');
  expect(result.text).toMatch(
    /Command\s+terminal-bench-2\.0 run --num-tasks 10/,
  );
  expect(result.text).toContain(`Job dir      ${jobDir}`);
  expect(result.text).toContain('Score   0.500');
  expect(result.text).toContain('Trials  2');
  expect(result.text).toContain('Passed  1/2');
  expect(result.text).toContain('Errors  0');
  expect(result.text).toContain('▶️ Run');
  expect(result.text).not.toContain('Stdout tail:');
  expect(result.text).not.toContain('Terminal-Bench 2.0 Native Run');
  expect(result.text).not.toContain('docker warning');
});

test('does not count recovered terminal-bench task warnings as errors', async () => {
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-eval-run-'),
  );
  const runDir = path.join(
    dataDir,
    'evals',
    'eval-terminal-bench-run-recovered-warning-abc123',
  );
  fs.mkdirSync(runDir, { recursive: true });
  const jobDir = path.join(
    dataDir,
    'evals',
    'terminal-bench-2.0',
    'jobs',
    '2026-04-07T11-19-35-721Z',
  );
  fs.mkdirSync(jobDir, { recursive: true });
  fs.writeFileSync(
    path.join(jobDir, 'result.json'),
    JSON.stringify(
      {
        agent: 'main',
        dataset: 'terminal-bench',
        trials: 2,
        errors: 1,
        mean: 1,
        rewards: [
          {
            taskName: 'adaptive-rejection-sampler',
            reward: 1,
            passed: true,
            error:
              'HybridAI API error 400: No tool output found for function call call_123.',
          },
          {
            taskName: 'bn-fit-modify',
            reward: 1,
            passed: true,
          },
        ],
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(runDir, 'stdout.log'),
    `Terminal-Bench 2.0 Native Run\nJob dir: ${jobDir}\nResults written to ${path.join(jobDir, 'result.json')}\n`,
  );
  fs.writeFileSync(path.join(runDir, 'stderr.log'), '');
  fs.writeFileSync(
    path.join(runDir, 'run.json'),
    JSON.stringify(
      {
        runId: 'eval-terminal-bench-run-recovered-warning',
        suiteId: 'terminal-bench-2.0',
        operation: 'run',
        pid: 8896,
        startedAt: '2026-04-07T11:19:33.032Z',
        finishedAt: '2026-04-07T11:21:33.032Z',
        cwd: process.cwd(),
        command:
          `${process.execPath} ${path.join(process.cwd(), 'dist', 'cli.js')} __eval-terminal-bench-native --install-dir ${path.join(dataDir, 'evals', 'terminal-bench-2.0')} --data-dir ${dataDir} --agent-id main --model hybridai/gpt-4.1-mini --prompt-mode none --num-tasks 2 --n-concurrent 1`,
        displayCommand: 'terminal-bench-2.0 run --num-tasks 2',
        openaiBaseUrl: 'http://127.0.0.1:9090/v1',
        model: 'hybridai/gpt-4.1-mini',
        baseModel: 'hybridai/gpt-4.1-mini',
        authMode: 'loopback',
        profile: {
          workspaceMode: 'current-agent',
          ablateSystemPrompt: false,
          includePromptParts: [],
          omitPromptParts: [],
        },
        stdoutPath: path.join(runDir, 'stdout.log'),
        stderrPath: path.join(runDir, 'stderr.log'),
      },
      null,
      2,
    ),
  );

  const { handleEvalCommand } = await import('../src/evals/eval-command.ts');
  const result = await handleEvalCommand({
    args: ['terminal-bench-2.0', 'results'],
    dataDir,
    gatewayBaseUrl: 'http://127.0.0.1:9090',
    webApiToken: '',
    effectiveAgentId: 'main',
    effectiveModel: 'hybridai/gpt-4.1-mini',
  });

  expect(result.kind).toBe('info');
  expect(result.text).toContain('Evaluated model  hybridai/gpt-4.1-mini');
  expect(result.text).toContain('Harness          HybridClaw v0.11.0');
  expect(result.text).toContain('Score   1.000');
  expect(result.text).toContain('Passed  2/2');
  expect(result.text).toContain('Errors  0');
});

test('shows partial terminal-bench progress in results while a run is still active', async () => {
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-eval-run-'),
  );
  const runDir = path.join(
    dataDir,
    'evals',
    'eval-terminal-bench-run-partial-abc123',
  );
  fs.mkdirSync(runDir, { recursive: true });
  const jobDir = path.join(
    dataDir,
    'evals',
    'terminal-bench-2.0',
    'jobs',
    '2026-04-07T10-27-23-793Z',
  );
  fs.mkdirSync(path.join(jobDir, 'bn-fit-modify'), { recursive: true });
  fs.writeFileSync(
    path.join(jobDir, 'bn-fit-modify', 'summary.json'),
    JSON.stringify(
      {
        taskName: 'bn-fit-modify',
        reward: 1,
        passed: true,
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(runDir, 'stdout.log'),
    [
      'Terminal-Bench 2.0 Native Run',
      `Job dir: ${jobDir}`,
      'Agent: main',
      'Model: hybridai/gpt-4.1-mini',
      'Prompt mode: none',
      'Tasks: 2',
      'Concurrency: 1',
      '',
      '[1/2] START adaptive-rejection-sampler',
      '[2/2] START bn-fit-modify',
      '[2/2] PASS bn-fit-modify reward=1.000 182s',
    ].join('\n'),
  );
  fs.writeFileSync(path.join(runDir, 'stderr.log'), '');
  fs.writeFileSync(
    path.join(runDir, 'run.json'),
    JSON.stringify(
      {
        runId: 'eval-terminal-bench-run-partial',
        suiteId: 'terminal-bench-2.0',
        operation: 'run',
        pid: 8895,
        startedAt: '2026-04-07T10:27:20.465Z',
        cwd: process.cwd(),
        command:
          `${process.execPath} ${path.join(process.cwd(), 'dist', 'cli.js')} __eval-terminal-bench-native --install-dir ${path.join(dataDir, 'evals', 'terminal-bench-2.0')} --data-dir ${dataDir} --agent-id main --model hybridai/gpt-4.1-mini --prompt-mode none --num-tasks 2 --n-concurrent 1`,
        displayCommand: 'terminal-bench-2.0 run --num-tasks 2',
        openaiBaseUrl: 'http://127.0.0.1:9090/v1',
        model: 'hybridai/gpt-4.1-mini',
        baseModel: 'hybridai/gpt-4.1-mini',
        authMode: 'loopback',
        profile: {
          workspaceMode: 'current-agent',
          ablateSystemPrompt: false,
          includePromptParts: [],
          omitPromptParts: [],
        },
        stdoutPath: path.join(runDir, 'stdout.log'),
        stderrPath: path.join(runDir, 'stderr.log'),
      },
      null,
      2,
    ),
  );

  process.kill = vi.fn(() => true) as typeof process.kill;

  const { handleEvalCommand } = await import('../src/evals/eval-command.ts');
  const result = await handleEvalCommand({
    args: ['terminal-bench-2.0', 'results'],
    dataDir,
    gatewayBaseUrl: 'http://127.0.0.1:9090',
    webApiToken: '',
    effectiveAgentId: 'main',
    effectiveModel: 'hybridai/gpt-4.1-mini',
  });

  expect(result.kind).toBe('info');
  expect(result.text).toContain('Evaluated model  hybridai/gpt-4.1-mini');
  expect(result.text).toContain('Harness          HybridClaw v0.11.0');
  expect(result.text).toContain('Overview');
  expect(result.text).toContain('Progress');
  expect(result.text).toContain('Run');
  expect(result.text).toContain('Paths');
  expect(result.text).toContain('Status           running');
  expect(result.text).toContain(`Job dir  ${jobDir}`);
  expect(result.text).toContain('Tasks     2');
  expect(result.text).toContain('Finished  1/2');
  expect(result.text).toContain('Passed    1');
  expect(result.text).toContain('Failed    0');
  expect(result.text).toContain('Running   1');
  expect(result.text).toContain('Pending   0');
  expect(result.text).toContain('▶️ Run');
  expect(result.text).not.toContain('Result JSON:');
  expect(result.text).not.toContain('Score:');
});

test('shows managed suite log tails in logs view', async () => {
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-eval-run-'),
  );
  const runDir = path.join(
    dataDir,
    'evals',
    'eval-terminal-bench-run-logs-abc123',
  );
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(runDir, 'stdout.log'),
    'Terminal-Bench 2.0 Native Run\nResults written to jobs/test/result.json\n',
  );
  fs.writeFileSync(path.join(runDir, 'stderr.log'), 'docker warning\n');
  fs.writeFileSync(
    path.join(runDir, 'run.json'),
    JSON.stringify(
      {
        runId: 'eval-terminal-bench-run-logs',
        suiteId: 'terminal-bench-2.0',
        operation: 'run',
        pid: 8890,
        startedAt: '2026-04-06T20:00:00.000Z',
        finishedAt: '2026-04-06T20:05:00.000Z',
        exitCode: 0,
        cwd: process.cwd(),
        command:
          `${process.execPath} ${path.join(process.cwd(), 'dist', 'cli.js')} __eval-terminal-bench-native --install-dir ${path.join(dataDir, 'evals', 'terminal-bench-2.0')} --data-dir ${dataDir} --agent-id main --model hybridai/gpt-4.1-mini --prompt-mode none --num-tasks 10 --n-concurrent 1`,
        displayCommand: 'terminal-bench-2.0 run --num-tasks 10',
        openaiBaseUrl: 'http://127.0.0.1:9090/v1',
        model: 'hybridai/gpt-4.1-mini',
        baseModel: 'hybridai/gpt-4.1-mini',
        authMode: 'loopback',
        profile: {
          workspaceMode: 'current-agent',
          ablateSystemPrompt: false,
          includePromptParts: [],
          omitPromptParts: [],
        },
        stdoutPath: path.join(runDir, 'stdout.log'),
        stderrPath: path.join(runDir, 'stderr.log'),
      },
      null,
      2,
    ),
  );

  const { handleEvalCommand } = await import('../src/evals/eval-command.ts');
  const result = await handleEvalCommand({
    args: ['terminal-bench-2.0', 'logs'],
    dataDir,
    gatewayBaseUrl: 'http://127.0.0.1:9090',
    webApiToken: '',
    effectiveAgentId: 'main',
    effectiveModel: 'hybridai/gpt-4.1-mini',
  });

  expect(result.kind).toBe('info');
  expect(result.title).toBe('Terminal-Bench 2.0 Logs');
  expect(result.text).toContain('Stdout tail:');
  expect(result.text).toContain('Stderr tail:');
  expect(result.text).toContain('Terminal-Bench 2.0 Native Run');
  expect(result.text).toContain('docker warning');
});

test('stops managed suite runs and marks the run metadata as terminated', async () => {
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-eval-run-'),
  );
  const runDir = path.join(
    dataDir,
    'evals',
    'eval-terminal-bench-run-stop-abc123',
  );
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'stdout.log'), '');
  fs.writeFileSync(path.join(runDir, 'stderr.log'), '');
  const metaPath = path.join(runDir, 'run.json');
  fs.writeFileSync(
    metaPath,
    JSON.stringify(
      {
        runId: 'eval-terminal-bench-run-stop',
        suiteId: 'terminal-bench-2.0',
        operation: 'run',
        pid: 8891,
        startedAt: '2026-04-06T20:00:00.000Z',
        cwd: process.cwd(),
        command:
          `${process.execPath} ${path.join(process.cwd(), 'dist', 'cli.js')} __eval-terminal-bench-native --install-dir ${path.join(dataDir, 'evals', 'terminal-bench-2.0')} --data-dir ${dataDir} --agent-id main --model hybridai/gpt-4.1-mini --prompt-mode none --num-tasks 10 --n-concurrent 1`,
        displayCommand: 'terminal-bench-2.0 run --num-tasks 10',
        openaiBaseUrl: 'http://127.0.0.1:9090/v1',
        model: 'hybridai/gpt-4.1-mini',
        baseModel: 'hybridai/gpt-4.1-mini',
        authMode: 'loopback',
        profile: {
          workspaceMode: 'current-agent',
          ablateSystemPrompt: false,
          includePromptParts: [],
          omitPromptParts: [],
        },
        stdoutPath: path.join(runDir, 'stdout.log'),
        stderrPath: path.join(runDir, 'stderr.log'),
      },
      null,
      2,
    ),
  );

  process.kill = vi.fn(() => true) as typeof process.kill;

  const { handleEvalCommand } = await import('../src/evals/eval-command.ts');
  const result = await handleEvalCommand({
    args: ['terminal-bench-2.0', 'stop'],
    dataDir,
    gatewayBaseUrl: 'http://127.0.0.1:9090',
    webApiToken: '',
    effectiveAgentId: 'main',
    effectiveModel: 'hybridai/gpt-4.1-mini',
  });

  expect(result.kind).toBe('info');
  expect(result.title).toBe('Terminal-Bench 2.0 Stop');
  expect(result.text).toContain(
    'Stopped run run eval-terminal-bench-run-stop.',
  );
  expect(process.kill).toHaveBeenCalledWith(8891, 0);
  expect(process.kill).toHaveBeenCalledWith(-8891, 'SIGTERM');

  const updated = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as {
    finishedAt?: string;
    exitSignal?: string | null;
  };
  expect(updated.finishedAt).toBeTruthy();
  expect(updated.exitSignal).toBe('SIGTERM');
});

test('requires tau2 setup before tau2 run', async () => {
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-eval-run-'),
  );

  const { handleEvalCommand } = await import('../src/evals/eval-command.ts');
  const result = await handleEvalCommand({
    args: [
      'tau2',
      'run',
      '--domain',
      'telecom',
      '--num-trials',
      '1',
      '--num-tasks',
      '10',
    ],
    dataDir,
    gatewayBaseUrl: 'http://127.0.0.1:9090',
    webApiToken: '',
    effectiveAgentId: 'main',
    effectiveModel: 'hybridai/gpt-4.1-mini',
  });

  expect(result.kind).toBe('error');
  expect(result.text).toContain('Run `/eval tau2 setup` first.');
});

test('reports tau2 setup as still running before install completes', async () => {
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-eval-run-'),
  );
  const runDir = path.join(dataDir, 'evals', 'eval-setup-run-abc123');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(runDir, 'run.json'),
    JSON.stringify(
      {
        runId: 'eval-setup-run',
        suiteId: 'tau2',
        operation: 'setup',
        pid: 7777,
        startedAt: '2026-04-06T19:35:57.269Z',
        cwd: path.join(dataDir, 'evals'),
        command: 'git clone ...',
        displayCommand: 'tau2 setup',
        openaiBaseUrl: 'http://127.0.0.1:9090/v1',
        model: 'hybridai/gpt-4.1-mini',
        baseModel: 'hybridai/gpt-4.1-mini',
        authMode: 'loopback',
        profile: {
          workspaceMode: 'current-agent',
          ablateSystemPrompt: false,
          includePromptParts: [],
          omitPromptParts: [],
        },
        stdoutPath: path.join(runDir, 'stdout.log'),
        stderrPath: path.join(runDir, 'stderr.log'),
      },
      null,
      2,
    ),
  );
  process.kill = vi.fn((pid: number, signal?: number | NodeJS.Signals) => {
    if (signal === 0 && pid === 7777) return true as never;
    return true as never;
  }) as typeof process.kill;

  const { handleEvalCommand } = await import('../src/evals/eval-command.ts');
  const result = await handleEvalCommand({
    args: [
      'tau2',
      'run',
      '--domain',
      'telecom',
      '--num-trials',
      '1',
      '--num-tasks',
      '10',
    ],
    dataDir,
    gatewayBaseUrl: 'http://127.0.0.1:9090',
    webApiToken: '',
    effectiveAgentId: 'main',
    effectiveModel: 'hybridai/gpt-4.1-mini',
  });

  expect(result.kind).toBe('error');
  expect(result.title).toBe('tau2 Setup Running');
  expect(result.text).toContain('tau2 setup is still running.');
  expect(result.text).toContain(
    'Use `/eval tau2 results` to inspect the setup logs.',
  );
});

test('runs managed tau2 with default llms when installed', async () => {
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-eval-run-'),
  );
  installTau2Layout(dataDir);
  spawnMock.mockReturnValue({
    pid: 6789,
    unref: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  });

  const { handleEvalCommand } = await import('../src/evals/eval-command.ts');
  const result = await handleEvalCommand({
    args: [
      'tau2',
      'run',
      '--domain',
      'telecom',
      '--num-trials',
      '1',
      '--num-tasks',
      '10',
    ],
    dataDir,
    gatewayBaseUrl: 'http://127.0.0.1:9090',
    webApiToken: '',
    effectiveAgentId: 'main',
    effectiveModel: 'hybridai/gpt-4.1-mini',
  });

  expect(result.kind).toBe('info');
  if (result.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${result.kind}`);
  }
  expect(result.title).toBe('tau2 Run Started');
  expect(result.text).toContain(
    'Command: tau2 run --domain telecom --num-trials 1 --num-tasks 10 --agent-llm "$HYBRIDCLAW_EVAL_MODEL" --user-llm "$HYBRIDCLAW_EVAL_MODEL"',
  );
  expect(result.text).toContain(
    'Use `/eval tau2 status` and `/eval tau2 results` to follow this run.',
  );

  const [, shellArgs] = spawnMock.mock.calls[0] as [string, string[]];
  expect(shellArgs[1]).toContain(path.join('tau2-bench', '.venv'));
  expect(shellArgs[1]).toContain('--agent-llm "$HYBRIDCLAW_EVAL_MODEL"');
  expect(shellArgs[1]).toContain('--user-llm "$HYBRIDCLAW_EVAL_MODEL"');
});

test('queues an initial tau2 progress bar for tui sessions', async () => {
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-eval-run-'),
  );
  installTau2Layout(dataDir);
  spawnMock.mockReturnValue({
    pid: 6791,
    unref: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  });

  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-home-'));
  process.env.HOME = homeDir;
  process.env.HYBRIDCLAW_HOME = path.join(homeDir, '.hybridclaw');

  const { initDatabase, claimQueuedProactiveMessages } = await import(
    '../src/memory/db.ts'
  );
  const { handleEvalCommand } = await import('../src/evals/eval-command.ts');

  initDatabase({ quiet: true });

  const result = await handleEvalCommand({
    args: [
      'tau2',
      'run',
      '--domain',
      'telecom',
      '--num-trials',
      '1',
      '--num-tasks',
      '10',
    ],
    channelId: 'tui',
    dataDir,
    gatewayBaseUrl: 'http://127.0.0.1:9090',
    webApiToken: '',
    effectiveAgentId: 'main',
    effectiveModel: 'hybridai/gpt-4.1-mini',
  });

  expect(result.kind).toBe('info');
  expect(result.text).toContain(
    'Progress: proactive tau2 bar queued to local tui channel (10 tasks)',
  );

  const messages = claimQueuedProactiveMessages('tui', 10);
  expect(messages).toHaveLength(1);
  expect(messages[0]?.text).toContain('tau2 [--------------------] 0/10 tasks');
});

test('queues a tau2 setup completion notification for tui sessions', async () => {
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-eval-run-'),
  );
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-home-'));
  process.env.HOME = homeDir;
  process.env.HYBRIDCLAW_HOME = path.join(homeDir, '.hybridclaw');

  const exitHandlers: Array<
    (code: number | null, signal: NodeJS.Signals | null) => void
  > = [];
  spawnMock.mockReturnValue({
    pid: 7001,
    unref: vi.fn(),
    off: vi.fn(),
    on: vi.fn(
      (
        event: string,
        handler: (code: number | null, signal: NodeJS.Signals | null) => void,
      ) => {
        if (event === 'exit') exitHandlers.push(handler);
      },
    ),
  });

  const { initDatabase, claimQueuedProactiveMessages } = await import(
    '../src/memory/db.ts'
  );
  const { handleEvalCommand } = await import('../src/evals/eval-command.ts');

  initDatabase({ quiet: true });

  const result = await handleEvalCommand({
    args: ['tau2', 'setup'],
    channelId: 'tui',
    dataDir,
    gatewayBaseUrl: 'http://127.0.0.1:9090',
    webApiToken: '',
    effectiveAgentId: 'main',
    effectiveModel: 'hybridai/gpt-4.1-mini',
  });

  expect(result.kind).toBe('info');
  expect(exitHandlers.length).toBeGreaterThan(0);
  for (const handler of exitHandlers) {
    handler(0, null);
  }

  const messages = claimQueuedProactiveMessages('tui', 10);
  expect(
    messages.some((message) =>
      message.text.includes('tau2 setup completed successfully.\n\nRun ID:'),
    ),
  ).toBe(true);
});

test('queues a tau2 setup failure notification for tui sessions', async () => {
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-eval-run-'),
  );
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-home-'));
  process.env.HOME = homeDir;
  process.env.HYBRIDCLAW_HOME = path.join(homeDir, '.hybridclaw');

  const exitHandlers: Array<
    (code: number | null, signal: NodeJS.Signals | null) => void
  > = [];
  spawnMock.mockImplementation((_command, _args, options) => {
    const stderrFd = (options as { stdio: [string, number, number] }).stdio[2];
    fs.writeSync(
      stderrFd,
      "ERROR: Package 'tau2' requires a different Python\n",
    );
    return {
      pid: 7002,
      unref: vi.fn(),
      off: vi.fn(),
      on: vi.fn(
        (
          event: string,
          handler: (code: number | null, signal: NodeJS.Signals | null) => void,
        ) => {
          if (event === 'exit') exitHandlers.push(handler);
        },
      ),
    };
  });

  const { initDatabase, claimQueuedProactiveMessages } = await import(
    '../src/memory/db.ts'
  );
  const { handleEvalCommand } = await import('../src/evals/eval-command.ts');

  initDatabase({ quiet: true });

  const result = await handleEvalCommand({
    args: ['tau2', 'setup'],
    channelId: 'tui',
    dataDir,
    gatewayBaseUrl: 'http://127.0.0.1:9090',
    webApiToken: '',
    effectiveAgentId: 'main',
    effectiveModel: 'hybridai/gpt-4.1-mini',
  });

  expect(result.kind).toBe('info');
  expect(exitHandlers.length).toBeGreaterThan(0);
  for (const handler of exitHandlers) {
    handler(1, null);
  }

  const messages = claimQueuedProactiveMessages('tui', 20);
  expect(
    messages.some((message) => message.text.includes('tau2 setup failed.')),
  ).toBe(true);
  expect(
    messages.some((message) =>
      message.text.includes('tau2 setup failed.\n\nRun ID:'),
    ),
  ).toBe(true);
  expect(
    messages.some((message) => message.text.includes('Reason: ERROR: Package')),
  ).toBe(true);
});

test('queues a tau2 run completion notification without a duplicate generic finished message', async () => {
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-eval-run-'),
  );
  installTau2Layout(dataDir);
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-home-'));
  process.env.HOME = homeDir;
  process.env.HYBRIDCLAW_HOME = path.join(homeDir, '.hybridclaw');

  const exitHandlers: Array<
    (code: number | null, signal: NodeJS.Signals | null) => void
  > = [];
  spawnMock.mockImplementation((_command, _args, options) => {
    const stdoutFd = (options as { stdio: [string, number, number] }).stdio[1];
    fs.writeSync(
      stdoutFd,
      'Total Tasks               10\nAverage Reward         0.6000\nPass^1                 0.600\nDB Match              ✓ 3 / ✗ 7 (30.0%)\nNormal Stop            10 (👤 10 / 🤖 0)\n',
    );
    return {
      pid: 7003,
      unref: vi.fn(),
      off: vi.fn(),
      on: vi.fn(
        (
          event: string,
          handler: (code: number | null, signal: NodeJS.Signals | null) => void,
        ) => {
          if (event === 'exit') exitHandlers.push(handler);
        },
      ),
    };
  });

  const { initDatabase, claimQueuedProactiveMessages } = await import(
    '../src/memory/db.ts'
  );
  const { handleEvalCommand } = await import('../src/evals/eval-command.ts');

  initDatabase({ quiet: true });

  const result = await handleEvalCommand({
    args: [
      'tau2',
      'run',
      '--domain',
      'telecom',
      '--num-trials',
      '1',
      '--num-tasks',
      '10',
    ],
    channelId: 'tui',
    dataDir,
    gatewayBaseUrl: 'http://127.0.0.1:9090',
    webApiToken: '',
    effectiveAgentId: 'main',
    effectiveModel: 'hybridai/gpt-4.1-mini',
  });

  expect(result.kind).toBe('info');
  expect(exitHandlers.length).toBeGreaterThan(0);
  for (const handler of exitHandlers) {
    handler(0, null);
  }

  const messages = claimQueuedProactiveMessages('tui', 20);
  expect(
    messages.some((message) =>
      message.text.includes('tau2 run completed.\n\nRun ID:'),
    ),
  ).toBe(true);
  expect(
    messages.some((message) =>
      message.text.includes('Success: 6/10 (0.600 reward pass)'),
    ),
  ).toBe(true);
  expect(
    messages.some((message) => message.text.includes('DB match: 3/10 (30.0%)')),
  ).toBe(true);
  expect(
    messages.some((message) =>
      message.text.includes('Conversations: 10 normal stop'),
    ),
  ).toBe(true);
  expect(
    messages.some((message) => message.text.includes('Eval finished')),
  ).toBe(false);
});

test('queues a tau2 run failure notification with the reason', async () => {
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-eval-run-'),
  );
  installTau2Layout(dataDir);
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-home-'));
  process.env.HOME = homeDir;
  process.env.HYBRIDCLAW_HOME = path.join(homeDir, '.hybridclaw');

  const exitHandlers: Array<
    (code: number | null, signal: NodeJS.Signals | null) => void
  > = [];
  spawnMock.mockImplementation((_command, _args, options) => {
    const stderrFd = (options as { stdio: [string, number, number] }).stdio[2];
    fs.writeSync(stderrFd, 'ERROR: telecom credentials missing\n');
    return {
      pid: 7004,
      unref: vi.fn(),
      off: vi.fn(),
      on: vi.fn(
        (
          event: string,
          handler: (code: number | null, signal: NodeJS.Signals | null) => void,
        ) => {
          if (event === 'exit') exitHandlers.push(handler);
        },
      ),
    };
  });

  const { initDatabase, claimQueuedProactiveMessages } = await import(
    '../src/memory/db.ts'
  );
  const { handleEvalCommand } = await import('../src/evals/eval-command.ts');

  initDatabase({ quiet: true });

  const result = await handleEvalCommand({
    args: [
      'tau2',
      'run',
      '--domain',
      'telecom',
      '--num-trials',
      '1',
      '--num-tasks',
      '10',
    ],
    channelId: 'tui',
    dataDir,
    gatewayBaseUrl: 'http://127.0.0.1:9090',
    webApiToken: '',
    effectiveAgentId: 'main',
    effectiveModel: 'hybridai/gpt-4.1-mini',
  });

  expect(result.kind).toBe('info');
  expect(exitHandlers.length).toBeGreaterThan(0);
  for (const handler of exitHandlers) {
    handler(2, null);
  }

  const messages = claimQueuedProactiveMessages('tui', 20);
  expect(
    messages.some((message) =>
      message.text.includes('tau2 run failed.\n\nRun ID:'),
    ),
  ).toBe(true);
  expect(
    messages.some((message) =>
      message.text.includes('Reason: ERROR: telecom credentials missing'),
    ),
  ).toBe(true);
  expect(
    messages.some((message) => message.text.includes('Eval finished')),
  ).toBe(false);
});

test('preserves explicit tau2 llm flags', async () => {
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-eval-run-'),
  );
  installTau2Layout(dataDir);
  spawnMock.mockReturnValue({
    pid: 6790,
    unref: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  });

  const { handleEvalCommand } = await import('../src/evals/eval-command.ts');
  const result = await handleEvalCommand({
    args: [
      'tau2',
      'run',
      '--domain',
      'telecom',
      '--agent-llm',
      'custom-agent',
      '--user-llm=custom-user',
      '--num-trials',
      '1',
      '--num-tasks',
      '10',
    ],
    dataDir,
    gatewayBaseUrl: 'http://127.0.0.1:9090',
    webApiToken: '',
    effectiveAgentId: 'main',
    effectiveModel: 'hybridai/gpt-4.1-mini',
  });

  expect(result.kind).toBe('info');
  if (result.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${result.kind}`);
  }
  expect(result.text).toContain(
    'Command: tau2 run --domain telecom --agent-llm custom-agent --user-llm=custom-user --num-trials 1 --num-tasks 10',
  );
});

test('reports tau2 install and latest run status', async () => {
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-eval-run-'),
  );
  installTau2Layout(dataDir);
  const runDir = path.join(dataDir, 'evals', 'eval-test-run-abc123');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(runDir, 'run.json'),
    JSON.stringify(
      {
        runId: 'eval-test-run',
        suiteId: 'tau2',
        operation: 'run',
        pid: 4444,
        startedAt: '2026-04-06T18:00:00.000Z',
        cwd: path.join(dataDir, 'evals', 'tau2-bench'),
        command: 'tau2 run --domain telecom',
        displayCommand: 'tau2 run --domain telecom',
        openaiBaseUrl: 'http://127.0.0.1:9090/v1',
        model: 'hybridai/gpt-4.1-mini',
        baseModel: 'hybridai/gpt-4.1-mini',
        authMode: 'loopback',
        profile: {
          workspaceMode: 'current-agent',
          ablateSystemPrompt: false,
          includePromptParts: [],
          omitPromptParts: [],
        },
        stdoutPath: path.join(runDir, 'stdout.log'),
        stderrPath: path.join(runDir, 'stderr.log'),
        progress: {
          kind: 'tau2',
          label: 'tau2',
          unit: 'tasks',
          total: 10,
          completed: 4,
          status: 'running',
          updatedAt: '2026-04-06T18:01:00.000Z',
        },
      },
      null,
      2,
    ),
  );
  process.kill = vi.fn((pid: number, signal?: number | NodeJS.Signals) => {
    if (signal === 0 && pid === 4444) return true as never;
    return true as never;
  }) as typeof process.kill;

  const { handleEvalCommand } = await import('../src/evals/eval-command.ts');
  const result = await handleEvalCommand({
    args: ['tau2', 'status'],
    dataDir,
    gatewayBaseUrl: 'http://127.0.0.1:9090',
    webApiToken: '',
    effectiveAgentId: 'main',
    effectiveModel: 'hybridai/gpt-4.1-mini',
  });

  expect(result.kind).toBe('info');
  expect(result.text).toContain('Installed: yes');
  expect(result.text).toContain('Latest run: eval-test-run (running)');
  expect(result.text).toContain('Progress: tau2 4/10 tasks');
});

test('reports tau2 success metric in status output for completed runs', async () => {
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-eval-run-'),
  );
  installTau2Layout(dataDir);
  const runDir = path.join(dataDir, 'evals', 'eval-status-summary-abc123');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(runDir, 'stdout.log'),
    'Total Tasks               10\nAverage Reward         0.6000\nPass^1                 0.600\nDB Match              ✓ 3 / ✗ 7 (30.0%)\nNormal Stop            10 (👤 10 / 🤖 0)\n',
  );
  fs.writeFileSync(path.join(runDir, 'stderr.log'), '');
  fs.writeFileSync(
    path.join(runDir, 'run.json'),
    JSON.stringify(
      {
        runId: 'eval-status-summary',
        suiteId: 'tau2',
        operation: 'run',
        pid: 4445,
        startedAt: '2026-04-06T18:00:00.000Z',
        finishedAt: '2026-04-06T18:05:00.000Z',
        exitCode: 0,
        cwd: path.join(dataDir, 'evals', 'tau2-bench'),
        command: 'tau2 run --domain telecom',
        displayCommand: 'tau2 run --domain telecom',
        openaiBaseUrl: 'http://127.0.0.1:9090/v1',
        model: 'hybridai/gpt-4.1-mini',
        baseModel: 'hybridai/gpt-4.1-mini',
        authMode: 'loopback',
        profile: {
          workspaceMode: 'current-agent',
          ablateSystemPrompt: false,
          includePromptParts: [],
          omitPromptParts: [],
        },
        stdoutPath: path.join(runDir, 'stdout.log'),
        stderrPath: path.join(runDir, 'stderr.log'),
        progress: {
          kind: 'tau2',
          label: 'tau2',
          unit: 'tasks',
          total: 10,
          completed: 0,
          status: 'exited',
          updatedAt: '2026-04-06T18:05:00.000Z',
        },
      },
      null,
      2,
    ),
  );

  const { handleEvalCommand } = await import('../src/evals/eval-command.ts');
  const result = await handleEvalCommand({
    args: ['tau2', 'status'],
    dataDir,
    gatewayBaseUrl: 'http://127.0.0.1:9090',
    webApiToken: '',
    effectiveAgentId: 'main',
    effectiveModel: 'hybridai/gpt-4.1-mini',
  });

  expect(result.kind).toBe('info');
  expect(result.text).toContain('Latest run: eval-status-summary (exited)');
  expect(result.text).toContain('Success: 6/10 (0.600 reward pass)');
  expect(result.text).toContain('DB match: 3/10 (30.0%)');
  expect(result.text).toContain('Conversations: 10 normal stop');
  expect(result.text).not.toContain('Progress: tau2 0/10 tasks');
});

test('reports tau2 setup failure reason in status output', async () => {
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-eval-run-'),
  );
  const runDir = path.join(dataDir, 'evals', 'eval-setup-failed-abc123');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(runDir, 'stderr.log'),
    "ERROR: Package 'tau2' requires a different Python: 3.14.3 not in '<3.14,>=3.12'\n",
  );
  fs.writeFileSync(
    path.join(runDir, 'stdout.log'),
    'Preparing editable metadata\n',
  );
  fs.writeFileSync(
    path.join(runDir, 'run.json'),
    JSON.stringify(
      {
        runId: 'eval-setup-failed',
        suiteId: 'tau2',
        operation: 'setup',
        pid: 9999,
        startedAt: '2026-04-06T20:00:00.000Z',
        finishedAt: '2026-04-06T20:01:00.000Z',
        exitCode: 1,
        cwd: path.join(dataDir, 'evals'),
        command: 'tau2 setup',
        displayCommand: 'tau2 setup',
        openaiBaseUrl: 'http://127.0.0.1:9090/v1',
        model: 'hybridai/gpt-4.1-mini',
        baseModel: 'hybridai/gpt-4.1-mini',
        authMode: 'loopback',
        profile: {
          workspaceMode: 'current-agent',
          ablateSystemPrompt: false,
          includePromptParts: [],
          omitPromptParts: [],
        },
        stdoutPath: path.join(runDir, 'stdout.log'),
        stderrPath: path.join(runDir, 'stderr.log'),
      },
      null,
      2,
    ),
  );

  const { handleEvalCommand } = await import('../src/evals/eval-command.ts');
  const result = await handleEvalCommand({
    args: ['tau2', 'status'],
    dataDir,
    gatewayBaseUrl: 'http://127.0.0.1:9090',
    webApiToken: '',
    effectiveAgentId: 'main',
    effectiveModel: 'hybridai/gpt-4.1-mini',
  });

  expect(result.kind).toBe('info');
  expect(result.text).toContain('Latest setup: eval-setup-failed (exited)');
  expect(result.text).toContain(
    "Setup failure: ERROR: Package 'tau2' requires a different Python: 3.14.3 not in '<3.14,>=3.12'",
  );
});

test('stops the latest running tau2 process', async () => {
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-eval-run-'),
  );
  const runDir = path.join(dataDir, 'evals', 'eval-stop-run-abc123');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(runDir, 'run.json'),
    JSON.stringify(
      {
        runId: 'eval-stop-run',
        suiteId: 'tau2',
        operation: 'run',
        pid: 5555,
        startedAt: '2026-04-06T19:00:00.000Z',
        cwd: process.cwd(),
        command: 'tau2 run --domain telecom',
        openaiBaseUrl: 'http://127.0.0.1:9090/v1',
        model: 'hybridai/gpt-4.1-mini',
        baseModel: 'hybridai/gpt-4.1-mini',
        authMode: 'loopback',
        profile: {
          workspaceMode: 'current-agent',
          ablateSystemPrompt: false,
          includePromptParts: [],
          omitPromptParts: [],
        },
        stdoutPath: path.join(runDir, 'stdout.log'),
        stderrPath: path.join(runDir, 'stderr.log'),
      },
      null,
      2,
    ),
  );
  process.kill = vi.fn((pid: number, signal?: number | NodeJS.Signals) => {
    if (signal === 0 && pid === 5555) return true as never;
    return true as never;
  }) as typeof process.kill;

  const { handleEvalCommand } = await import('../src/evals/eval-command.ts');
  const result = await handleEvalCommand({
    args: ['tau2', 'stop'],
    dataDir,
    gatewayBaseUrl: 'http://127.0.0.1:9090',
    webApiToken: '',
    effectiveAgentId: 'main',
    effectiveModel: 'hybridai/gpt-4.1-mini',
  });

  expect(result.kind).toBe('info');
  expect(result.text).toContain('Sent SIGTERM to tau2 run eval-stop-run');
  expect(process.kill).toHaveBeenCalled();
});

test('shows latest tau2 results from log tails', async () => {
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-eval-run-'),
  );
  const runDir = path.join(dataDir, 'evals', 'eval-results-run-abc123');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(runDir, 'stdout.log'),
    [
      'preface line',
      '╭───────────────────────── Agent Performance Metrics ──────────────────────────╮',
      '│   ═══ Overview ═══                                                           │',
      '│   Total Simulations         10                                               │',
      '│   Total Tasks               10                                               │',
      '│                                                                              │',
      '│   ═══ Reward Metrics ═══                                                     │',
      '│   🏆 Average Reward         0.6000                                           │',
      '│      Pass^1                 0.600                                            │',
      '│   💰 Avg Cost/Conversation  $0.1259                                          │',
      '│                                                                              │',
      '│   ═══ DB Match ═══                                                           │',
      '│   🗄️  DB Match              ✓ 3 / ✗ 7 (30.0%)                                │',
      '│                                                                              │',
      '│   ═══ Termination ═══                                                        │',
      '│   🛑 Normal Stop            10 (👤 10 / 🤖 0)                                │',
      '╰──────────────────────────────────────────────────────────────────────────────╯',
      'all done',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(path.join(runDir, 'stderr.log'), 'warning line\n');
  fs.writeFileSync(
    path.join(runDir, 'run.json'),
    JSON.stringify(
      {
        runId: 'eval-results-run',
        suiteId: 'tau2',
        operation: 'run',
        pid: 6666,
        startedAt: '2026-04-06T20:00:00.000Z',
        finishedAt: '2026-04-06T20:05:00.000Z',
        cwd: process.cwd(),
        command: 'tau2 run --domain telecom',
        displayCommand: 'tau2 run --domain telecom',
        openaiBaseUrl: 'http://127.0.0.1:9090/v1',
        model: 'hybridai/gpt-4.1-mini',
        baseModel: 'hybridai/gpt-4.1-mini',
        authMode: 'loopback',
        profile: {
          workspaceMode: 'current-agent',
          ablateSystemPrompt: false,
          includePromptParts: [],
          omitPromptParts: [],
        },
        stdoutPath: path.join(runDir, 'stdout.log'),
        stderrPath: path.join(runDir, 'stderr.log'),
        progress: {
          kind: 'tau2',
          label: 'tau2',
          unit: 'tasks',
          total: 10,
          completed: 10,
          status: 'exited',
          updatedAt: '2026-04-06T20:05:00.000Z',
        },
      },
      null,
      2,
    ),
  );

  const { handleEvalCommand } = await import('../src/evals/eval-command.ts');
  const result = await handleEvalCommand({
    args: ['tau2', 'results'],
    dataDir,
    gatewayBaseUrl: 'http://127.0.0.1:9090',
    webApiToken: '',
    effectiveAgentId: 'main',
    effectiveModel: 'hybridai/gpt-4.1-mini',
  });

  expect(result.kind).toBe('info');
  expect(result.text).toContain('Evaluated model  hybridai/gpt-4.1-mini');
  expect(result.text).toContain('Harness          HybridClaw v0.11.0');
  expect(result.text).toContain('Overview');
  expect(result.text).toContain('Results');
  expect(result.text).toContain('Run');
  expect(result.text).toContain('Paths');
  expect(result.text).toContain('Status           exited');
  expect(result.text).toContain('Success: 6/10 (0.600 reward pass)');
  expect(result.text).toContain('DB match: 3/10 (30.0%)');
  expect(result.text).toContain('Conversations: 10 normal stop');
  expect(result.text).toContain('▶️ Run');
  expect(result.text).not.toContain('Progress: tau2 10/10 tasks');
  expect(result.text).toContain('Stdout tail');
  expect(result.text).toContain('Agent Performance Metrics');
  expect(result.text).toContain('Average Reward         0.6000');
  expect(result.text).toContain('Stderr tail');
  expect(result.text).toContain('warning line');
});

test('shows setup logs in tau2 results when no run exists yet', async () => {
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-eval-run-'),
  );
  const runDir = path.join(dataDir, 'evals', 'eval-setup-results-abc123');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'stdout.log'), 'cloning repo\n');
  fs.writeFileSync(path.join(runDir, 'stderr.log'), 'pip warning\n');
  fs.writeFileSync(
    path.join(runDir, 'run.json'),
    JSON.stringify(
      {
        runId: 'eval-setup-results',
        suiteId: 'tau2',
        operation: 'setup',
        pid: 8888,
        startedAt: '2026-04-06T20:00:00.000Z',
        cwd: process.cwd(),
        command: 'git clone ...',
        displayCommand: 'tau2 setup',
        openaiBaseUrl: 'http://127.0.0.1:9090/v1',
        model: 'hybridai/gpt-4.1-mini',
        baseModel: 'hybridai/gpt-4.1-mini',
        authMode: 'loopback',
        profile: {
          workspaceMode: 'current-agent',
          ablateSystemPrompt: false,
          includePromptParts: [],
          omitPromptParts: [],
        },
        stdoutPath: path.join(runDir, 'stdout.log'),
        stderrPath: path.join(runDir, 'stderr.log'),
      },
      null,
      2,
    ),
  );
  process.kill = vi.fn((pid: number, signal?: number | NodeJS.Signals) => {
    if (signal === 0 && pid === 8888) return true as never;
    return true as never;
  }) as typeof process.kill;

  const { handleEvalCommand } = await import('../src/evals/eval-command.ts');
  const result = await handleEvalCommand({
    args: ['tau2', 'results'],
    dataDir,
    gatewayBaseUrl: 'http://127.0.0.1:9090',
    webApiToken: '',
    effectiveAgentId: 'main',
    effectiveModel: 'hybridai/gpt-4.1-mini',
  });

  expect(result.kind).toBe('info');
  expect(result.text).toContain('Evaluated model  hybridai/gpt-4.1-mini');
  expect(result.text).toContain('Harness          HybridClaw v0.11.0');
  expect(result.text).toContain('Overview');
  expect(result.text).toContain('Run');
  expect(result.text).toContain('Paths');
  expect(result.text).toContain('Status           running');
  expect(result.text).toContain('▶️ Run');
  expect(result.text).toContain('cloning repo');
  expect(result.text).toContain('pip warning');
});

test('rejects the removed eval run syntax', async () => {
  const { handleEvalCommand } = await import('../src/evals/eval-command.ts');

  const result = await handleEvalCommand({
    args: ['run', 'python', '-m', 'swebench.harness.run_evaluation'],
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-eval-run-')),
    gatewayBaseUrl: 'http://127.0.0.1:9090',
    webApiToken: '',
    effectiveAgentId: 'main',
    effectiveModel: 'hybridai/gpt-4.1-mini',
  });

  expect(result.kind).toBe('error');
  expect(result.text).toContain(
    'Use `/eval <shell command...>` instead of `/eval run <shell command...>`.',
  );
});

test('encodes fresh-agent ablation options into the eval model', async () => {
  const { handleEvalCommand } = await import('../src/evals/eval-command.ts');

  const result = await handleEvalCommand({
    args: [
      'env',
      '--fresh-agent',
      '--ablate-system',
      '--omit-prompt=bootstrap,soul',
      '--include-prompt=memory',
    ],
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-eval-')),
    gatewayBaseUrl: 'http://127.0.0.1:9090',
    webApiToken: '',
    effectiveAgentId: 'main',
    effectiveModel: 'openai-codex/gpt-5.4',
  });

  expect(result.kind).toBe('info');
  if (result.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${result.kind}`);
  }
  expect(result.text).toContain(
    'HYBRIDCLAW_EVAL_MODEL=openai-codex/gpt-5.4__hc_eval=fresh-agent,ablate-system,include=memory,omit=bootstrap+soul',
  );
  expect(result.text).toContain('Agent setup: fresh temporary agent workspace');
  expect(result.text).toContain('System prompt: ablated');
  expect(result.text).toContain('Prompt include: memory');
  expect(result.text).toContain('Prompt omit: bootstrap, soul');
  expect(result.text).toContain('Workspace MEMORY.md: fresh template file');
});
