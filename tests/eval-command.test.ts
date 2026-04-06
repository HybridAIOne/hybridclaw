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
    fs.mkdirSync(path.join(installDir, '.venv', 'Scripts'), { recursive: true });
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

test('returns suite recipes without exposing tokens', async () => {
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
  expect(result.text).toContain('OPENAI_BASE_URL=http://127.0.0.1:9090/v1');
  expect(result.text).toContain('WEB_API_TOKEN injected automatically');
  expect(result.text).toContain(
    'HYBRIDCLAW_EVAL_MODEL=openai-codex/gpt-5.4__hc_eval=agent=charly',
  );
  expect(result.text).toContain('Agent setup: current agent workspace (charly)');
  expect(result.text).toContain(
    'Session state: fresh transient OpenAI-compatible session per request',
  );
  expect(result.text).not.toContain('secret-token');
});

test('starts detached eval runs with injected OpenAI-compatible env', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-eval-run-'));
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
  expect(result.text).toContain('/eval tau2 run --domain telecom --num-trials 1 --num-tasks 10');
});

test('starts detached tau2 setup', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-eval-run-'));
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
  expect(shellArgs[1]).toContain(".venv/bin/python' -c \"import tau2.cli\"");
});

test('starts detached swebench setup', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-eval-run-'));
  spawnMock.mockReturnValue({
    pid: 6791,
    unref: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  });

  const { handleEvalCommand } = await import('../src/evals/eval-command.ts');
  const result = await handleEvalCommand({
    args: ['swebench-verified', 'setup'],
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
  expect(result.title).toBe('SWE-bench Verified Setup Started');
  expect(result.text).toContain('Command: swebench-verified setup');
  expect(result.text).toContain(
    'Setup strategy: uv-managed Python 3.12 venv with editable SWE-bench install.',
  );
  expect(result.text).toContain('Use `/eval swebench-verified status`');
  expect(result.text).toContain('Use `/eval swebench-verified results`');

  const [, shellArgs] = spawnMock.mock.calls[0] as [string, string[]];
  expect(shellArgs[1]).toContain('github.com/princeton-nlp/SWE-bench.git');
  expect(shellArgs[1]).toContain('uv pip install --python');
  expect(shellArgs[1]).toContain('-e .');
  expect(shellArgs[1]).toContain('import swebench');
});

test('starts detached terminal-bench setup', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-eval-run-'));
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
    'Setup strategy: uv-managed Python 3.12 venv with Harbor CLI install and HybridClaw Harbor agent smoke test.',
  );
  expect(result.text).toContain('Use `/eval terminal-bench-2.0 status`');
  expect(result.text).toContain('Use `/eval terminal-bench-2.0 results`');

  const [, shellArgs] = spawnMock.mock.calls[0] as [string, string[]];
  expect(shellArgs[1]).toContain('uv pip install --python');
  expect(shellArgs[1]).toContain('harbor');
  expect(shellArgs[1]).toContain('import hybridclaw_harbor_agent');
  expect(
    fs.readFileSync(
      path.join(installDir, 'hybridclaw_harbor_agent.py'),
      'utf-8',
    ),
  ).toContain('class HybridClawHarborAgent(Terminus2):');
});

test('runs managed terminal-bench with HybridClaw Harbor agent defaults', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-eval-run-'));
  const installDir = path.join(dataDir, 'evals', 'terminal-bench-2.0');
  fs.mkdirSync(path.join(installDir, '.venv', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(installDir, '.venv', 'bin', 'python'), '');
  fs.writeFileSync(path.join(installDir, '.venv', 'bin', 'harbor'), '');
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
  expect(result.text).toContain('Command: terminal-bench-2.0 run --num-tasks 10');
  expect(result.text).toContain(
    'Use `/eval terminal-bench-2.0 status` and `/eval terminal-bench-2.0 results` to follow this run.',
  );

  const [, shellArgs] = spawnMock.mock.calls[0] as [string, string[]];
  expect(shellArgs[1]).toContain(path.join('terminal-bench-2.0', '.venv', 'bin', 'harbor'));
  expect(shellArgs[1]).toContain('run -l 10 -d terminal-bench@2.0 -n 1');
  expect(shellArgs[1]).toContain(
    '--agent-import-path hybridclaw_harbor_agent:HybridClawHarborAgent',
  );
  expect(shellArgs[1]).toContain('-m "$HYBRIDCLAW_EVAL_MODEL"');
  expect(fs.readFileSync(path.join(installDir, 'hybridclaw_harbor_agent.py'), 'utf-8')).toContain(
    'HYBRIDCLAW_EVAL_MODEL',
  );
});

test('caps managed terminal-bench concurrency at 4 when configured maxConcurrent leaves headroom', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-eval-run-'));
  const installDir = path.join(dataDir, 'evals', 'terminal-bench-2.0');
  fs.mkdirSync(path.join(installDir, '.venv', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(installDir, '.venv', 'bin', 'python'), '');
  fs.writeFileSync(path.join(installDir, '.venv', 'bin', 'harbor'), '');
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
  expect(shellArgs[1]).toContain('-n 4');
});

test('reserves one slot from configured terminal-bench concurrency defaults', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-eval-run-'));
  const installDir = path.join(dataDir, 'evals', 'terminal-bench-2.0');
  fs.mkdirSync(path.join(installDir, '.venv', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(installDir, '.venv', 'bin', 'python'), '');
  fs.writeFileSync(path.join(installDir, '.venv', 'bin', 'harbor'), '');
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
  expect(shellArgs[1]).toContain('-n 2');
});

test('preserves explicit terminal-bench concurrency override', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-eval-run-'));
  const installDir = path.join(dataDir, 'evals', 'terminal-bench-2.0');
  fs.mkdirSync(path.join(installDir, '.venv', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(installDir, '.venv', 'bin', 'python'), '');
  fs.writeFileSync(path.join(installDir, '.venv', 'bin', 'harbor'), '');
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
    args: ['terminal-bench-2.0', 'run', '--num-tasks', '10', '--n-concurrent', '2'],
    dataDir,
    gatewayBaseUrl: 'http://127.0.0.1:9090',
    webApiToken: '',
    effectiveAgentId: 'main',
    effectiveModel: 'hybridai/gpt-4.1-mini',
  });

  const [, shellArgs] = spawnMock.mock.calls[0] as [string, string[]];
  expect(shellArgs[1]).toContain('--n-concurrent 2');
  expect(shellArgs[1]).not.toContain('-n 4');
  expect(shellArgs[1]).not.toContain('-n 1');
});

test('reports fast tau2 setup failures inline with the reason', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-eval-run-'));
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
  expect(result.text).toContain("requires a different Python");
});

test('reports managed suite install state and latest setup status', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-eval-run-'));
  const installDir = path.join(dataDir, 'evals', 'gaia');
  fs.mkdirSync(path.join(installDir, '.venv', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(installDir, '.venv', 'bin', 'python'), '');
  fs.writeFileSync(path.join(installDir, '.venv', 'bin', 'inspect'), '');
  fs.writeFileSync(path.join(installDir, '.hybridclaw-setup-ok'), '');
  const runDir = path.join(dataDir, 'evals', 'eval-gaia-setup-abc123');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(runDir, 'run.json'),
    JSON.stringify(
      {
        runId: 'eval-gaia-setup',
        suiteId: 'gaia',
        operation: 'setup',
        pid: 4446,
        startedAt: '2026-04-06T18:00:00.000Z',
        finishedAt: '2026-04-06T18:05:00.000Z',
        exitCode: 0,
        cwd: installDir,
        command: 'gaia setup',
        displayCommand: 'gaia setup',
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
    args: ['gaia', 'status'],
    dataDir,
    gatewayBaseUrl: 'http://127.0.0.1:9090',
    webApiToken: '',
    effectiveAgentId: 'main',
    effectiveModel: 'hybridai/gpt-4.1-mini',
  });

  expect(result.kind).toBe('info');
  expect(result.text).toContain('Installed: yes');
  expect(result.text).toContain('Latest setup: eval-gaia-setup (exited)');
  expect(result.text).toContain(path.join('gaia', '.venv', 'bin', 'inspect'));
});

test('reports managed suite latest run in status output', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-eval-run-'));
  const installDir = path.join(dataDir, 'evals', 'terminal-bench-2.0');
  fs.mkdirSync(path.join(installDir, '.venv', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(installDir, '.venv', 'bin', 'python'), '');
  fs.writeFileSync(path.join(installDir, '.venv', 'bin', 'harbor'), '');
  fs.writeFileSync(path.join(installDir, '.hybridclaw-setup-ok'), '');
  const runDir = path.join(dataDir, 'evals', 'eval-terminal-bench-run-abc123');
  fs.mkdirSync(runDir, { recursive: true });
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
          'harbor run -d terminal-bench@2.0 --agent-import-path hybridclaw_harbor_agent:HybridClawHarborAgent -m "$HYBRIDCLAW_EVAL_MODEL" -l 10',
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
    args: ['terminal-bench-2.0', 'status'],
    dataDir,
    gatewayBaseUrl: 'http://127.0.0.1:9090',
    webApiToken: '',
    effectiveAgentId: 'main',
    effectiveModel: 'hybridai/gpt-4.1-mini',
  });

  expect(result.kind).toBe('info');
  expect(result.text).toContain('Latest run: eval-terminal-bench-run (exited)');
  expect(result.text).toContain('Command: terminal-bench-2.0 run --num-tasks 10');
});

test('shows generic managed suite setup logs in results', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-eval-run-'));
  const runDir = path.join(dataDir, 'evals', 'eval-terminal-bench-setup-abc123');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'stdout.log'), 'installed harbor\n');
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
  expect(result.text).toContain('Run ID: eval-terminal-bench-setup');
  expect(result.text).toContain('Operation: setup');
  expect(result.text).toContain('installed harbor');
  expect(result.text).toContain('docker check pending');
});

test('shows managed suite run logs in results when a run exists', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-eval-run-'));
  const runDir = path.join(dataDir, 'evals', 'eval-terminal-bench-run-results-abc123');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'stdout.log'), 'harbor summary line\n');
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
          'harbor run -d terminal-bench@2.0 --agent-import-path hybridclaw_harbor_agent:HybridClawHarborAgent -m "$HYBRIDCLAW_EVAL_MODEL" -l 10',
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
  expect(result.text).toContain('Operation: run');
  expect(result.text).toContain('Command: terminal-bench-2.0 run --num-tasks 10');
  expect(result.text).toContain('harbor summary line');
  expect(result.text).toContain('docker warning');
});

test('requires tau2 setup before tau2 run', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-eval-run-'));

  const { handleEvalCommand } = await import('../src/evals/eval-command.ts');
  const result = await handleEvalCommand({
    args: ['tau2', 'run', '--domain', 'telecom', '--num-trials', '1', '--num-tasks', '10'],
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-eval-run-'));
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
    args: ['tau2', 'run', '--domain', 'telecom', '--num-trials', '1', '--num-tasks', '10'],
    dataDir,
    gatewayBaseUrl: 'http://127.0.0.1:9090',
    webApiToken: '',
    effectiveAgentId: 'main',
    effectiveModel: 'hybridai/gpt-4.1-mini',
  });

  expect(result.kind).toBe('error');
  expect(result.title).toBe('tau2 Setup Running');
  expect(result.text).toContain('tau2 setup is still running.');
  expect(result.text).toContain('Use `/eval tau2 results` to inspect the setup logs.');
});

test('runs managed tau2 with default llms when installed', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-eval-run-'));
  installTau2Layout(dataDir);
  spawnMock.mockReturnValue({
    pid: 6789,
    unref: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  });

  const { handleEvalCommand } = await import('../src/evals/eval-command.ts');
  const result = await handleEvalCommand({
    args: ['tau2', 'run', '--domain', 'telecom', '--num-trials', '1', '--num-tasks', '10'],
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-eval-run-'));
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
    args: ['tau2', 'run', '--domain', 'telecom', '--num-trials', '1', '--num-tasks', '10'],
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-eval-run-'));
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
    on: vi.fn((event: string, handler: (code: number | null, signal: NodeJS.Signals | null) => void) => {
      if (event === 'exit') exitHandlers.push(handler);
    }),
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
  expect(messages.some((message) => message.text.includes('tau2 setup completed successfully.\n\nRun ID:'))).toBe(true);
});

test('queues a tau2 setup failure notification for tui sessions', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-eval-run-'));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-home-'));
  process.env.HOME = homeDir;
  process.env.HYBRIDCLAW_HOME = path.join(homeDir, '.hybridclaw');

  const exitHandlers: Array<
    (code: number | null, signal: NodeJS.Signals | null) => void
  > = [];
  spawnMock.mockImplementation((_command, _args, options) => {
    const stderrFd = (options as { stdio: [string, number, number] }).stdio[2];
    fs.writeSync(stderrFd, "ERROR: Package 'tau2' requires a different Python\n");
    return {
      pid: 7002,
      unref: vi.fn(),
      off: vi.fn(),
      on: vi.fn((event: string, handler: (code: number | null, signal: NodeJS.Signals | null) => void) => {
        if (event === 'exit') exitHandlers.push(handler);
      }),
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
  expect(messages.some((message) => message.text.includes('tau2 setup failed.'))).toBe(true);
  expect(messages.some((message) => message.text.includes('tau2 setup failed.\n\nRun ID:'))).toBe(true);
  expect(messages.some((message) => message.text.includes('Reason: ERROR: Package'))).toBe(true);
});

test('queues a tau2 run completion notification without a duplicate generic finished message', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-eval-run-'));
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
      on: vi.fn((event: string, handler: (code: number | null, signal: NodeJS.Signals | null) => void) => {
        if (event === 'exit') exitHandlers.push(handler);
      }),
    };
  });

  const { initDatabase, claimQueuedProactiveMessages } = await import(
    '../src/memory/db.ts'
  );
  const { handleEvalCommand } = await import('../src/evals/eval-command.ts');

  initDatabase({ quiet: true });

  const result = await handleEvalCommand({
    args: ['tau2', 'run', '--domain', 'telecom', '--num-trials', '1', '--num-tasks', '10'],
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
  expect(messages.some((message) => message.text.includes('tau2 run completed.\n\nRun ID:'))).toBe(true);
  expect(messages.some((message) => message.text.includes('Success: 6/10 (0.600 reward pass)'))).toBe(true);
  expect(messages.some((message) => message.text.includes('DB match: 3/10 (30.0%)'))).toBe(true);
  expect(messages.some((message) => message.text.includes('Conversations: 10 normal stop'))).toBe(true);
  expect(messages.some((message) => message.text.includes('Eval finished'))).toBe(false);
});

test('queues a tau2 run failure notification with the reason', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-eval-run-'));
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
      on: vi.fn((event: string, handler: (code: number | null, signal: NodeJS.Signals | null) => void) => {
        if (event === 'exit') exitHandlers.push(handler);
      }),
    };
  });

  const { initDatabase, claimQueuedProactiveMessages } = await import(
    '../src/memory/db.ts'
  );
  const { handleEvalCommand } = await import('../src/evals/eval-command.ts');

  initDatabase({ quiet: true });

  const result = await handleEvalCommand({
    args: ['tau2', 'run', '--domain', 'telecom', '--num-trials', '1', '--num-tasks', '10'],
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
  expect(messages.some((message) => message.text.includes('tau2 run failed.\n\nRun ID:'))).toBe(true);
  expect(messages.some((message) => message.text.includes('Reason: ERROR: telecom credentials missing'))).toBe(true);
  expect(messages.some((message) => message.text.includes('Eval finished'))).toBe(false);
});

test('preserves explicit tau2 llm flags', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-eval-run-'));
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-eval-run-'));
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-eval-run-'));
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-eval-run-'));
  const runDir = path.join(dataDir, 'evals', 'eval-setup-failed-abc123');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(runDir, 'stderr.log'),
    "ERROR: Package 'tau2' requires a different Python: 3.14.3 not in '<3.14,>=3.12'\n",
  );
  fs.writeFileSync(path.join(runDir, 'stdout.log'), 'Preparing editable metadata\n');
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-eval-run-'));
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-eval-run-'));
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
  expect(result.text).toContain('Run ID: eval-results-run');
  expect(result.text).toContain('Operation: run');
  expect(result.text).toContain('Success: 6/10 (0.600 reward pass)');
  expect(result.text).toContain('DB match: 3/10 (30.0%)');
  expect(result.text).toContain('Conversations: 10 normal stop');
  expect(result.text).not.toContain('Progress: tau2 10/10 tasks');
  expect(result.text).toContain('Stdout tail:');
  expect(result.text).toContain('Agent Performance Metrics');
  expect(result.text).toContain('Average Reward         0.6000');
  expect(result.text).toContain('Stderr tail:');
  expect(result.text).toContain('warning line');
});

test('shows setup logs in tau2 results when no run exists yet', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-eval-run-'));
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
  expect(result.text).toContain('Operation: setup');
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
