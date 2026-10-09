import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withToolActivityHeartbeat } from '../container/src/tool-activity-heartbeat.js';
import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return { ...original, spawn: vi.fn((...args: Parameters<typeof original.spawn>) => {
    const child = original.spawn(...args);
    if (child.stdin) vi.spyOn(child.stdin, 'end');
    return child;
  }) };
});

async function mockDockerSpawn(output: string) {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  vi.mocked(spawn).mockImplementation(() => {
    const child = actual.spawn('bash', ['-c', 'printf "hybridclaw-bash-pgid:999999\\n"; cat >/dev/null; printf %s "$TEST_OUTPUT"'], {
      env: { ...process.env, TEST_OUTPUT: output },
    });
    vi.spyOn(child.stdin, 'end');
    return child;
  });
}

describe.sequential('container bash tool persistence', () => {
  type ToolsModule = typeof import('../container/src/tools.js');

  let tools: ToolsModule | null = null;
  let workspaceRoot = '';

  async function loadTools(): Promise<ToolsModule> {
    tools = await import('../container/src/tools.js');
    return tools;
  }

  async function createBashTestRuntime(options?: {
    nested?: boolean;
    persistBashState?: boolean;
    sessionId?: string;
  }): Promise<ToolsModule> {
    workspaceRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-bash-tool-'),
    );
    if (options?.nested) {
      fs.mkdirSync(path.join(workspaceRoot, 'nested'), { recursive: true });
    }
    vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', workspaceRoot);
    const loadedTools = await loadTools();
    loadedTools.setPersistentBashStateEnabled(
      options?.persistBashState !== false,
    );
    if (options?.sessionId) {
      loadedTools.setSessionContext(options.sessionId);
    }
    return loadedTools;
  }

  function bashCommand(command: string): string {
    return JSON.stringify({ command });
  }

  // The NUL-terminated fields a launch writes to the wrapper's stdin.
  function stdinFields(options: unknown): string[] {
    const index = vi.mocked(spawn).mock.calls.findIndex((call) => call[2] === options);
    const child = vi.mocked(spawn).mock.results[index].value;
    return String(vi.mocked(child.stdin.end).mock.calls[0][0]).split('\0').slice(0, -1);
  }

  afterEach(async () => {
    await tools?.resetPersistentBashSessions();
    tools = null;
    vi.mocked(spawn).mockClear();
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    vi.mocked(spawn).mockImplementation((...args: Parameters<typeof actual.spawn>) => {
      const child = actual.spawn(...args);
      if (child.stdin) vi.spyOn(child.stdin, 'end');
      return child;
    });
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.resetModules();
    if (workspaceRoot) {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
      workspaceRoot = '';
    }
  });

  test.each([false, true])('emits heartbeats during a real shell command (persistent=%s)', async (persistBashState) => {
    const { executeTool } = await createBashTestRuntime({ persistBashState });
    const emit = vi.fn();
    const result = await withToolActivityHeartbeat(
      () => executeTool('bash', bashCommand('sleep 0.32; printf done')),
      emit,
      20,
    );
    expect(result).toBe('done');
    expect(emit.mock.calls.length).toBeGreaterThanOrEqual(5);
    const count = emit.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(emit).toHaveBeenCalledTimes(count);
  });

  test('persists cwd across bash calls in the same session', async () => {
    const { executeTool } = await createBashTestRuntime({
      nested: true,
      sessionId: `bash-session-cd-${Date.now()}`,
    });

    const first = await executeTool(
      'bash',
      bashCommand('cd nested && printf %s "$(basename "$PWD")"'),
    );
    const second = await executeTool(
      'bash',
      bashCommand('printf %s "$(basename "$PWD")"'),
    );

    expect(first).toBe('nested');
    expect(second).toBe('nested');
  });

  test('treats shell metacharacters in the environment temp path as literal arguments', async () => {
    const { executeTool } = await createBashTestRuntime();
    const tempRoot = path.join(
      workspaceRoot,
      '$(touch injected); `touch also-injected`',
    );
    fs.mkdirSync(tempRoot);
    vi.stubEnv('TMPDIR', tempRoot);

    expect(await executeTool('bash', bashCommand('printf safe'))).toBe('safe');
    expect(await executeTool('bash', bashCommand('printf still-safe'))).toBe(
      'still-safe',
    );
    expect(fs.existsSync(path.join(workspaceRoot, 'injected'))).toBe(false);
    expect(fs.existsSync(path.join(workspaceRoot, 'also-injected'))).toBe(false);
    const [, args, options] = vi
      .mocked(spawn)
      .mock.calls.find(([file]) => file === 'bash')!;
    expect(args).not.toContainEqual(expect.stringContaining(tempRoot));
    expect(stdinFields(options)[0]).toContain(tempRoot);
  });

  test('persists exported environment variables across bash calls', async () => {
    const { executeTool } = await createBashTestRuntime({
      sessionId: `bash-session-env-${Date.now()}`,
    });

    await executeTool(
      'bash',
      bashCommand('export HYBRIDCLAW_TEST_VAR=persisted'),
    );
    const result = await executeTool(
      'bash',
      bashCommand('printf %s "$HYBRIDCLAW_TEST_VAR"'),
    );

    expect(result).toBe('persisted');
  });

  test('does not expose ambient credential variables to host bash calls', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'openai-secret');
    vi.stubEnv('ANTHROPIC_API_KEY', 'anthropic-secret');
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'aws-access-key');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'aws-secret-key');
    vi.stubEnv('AWS_SESSION_TOKEN', 'aws-session-token');
    vi.stubEnv('GITHUB_TOKEN', 'github-token');
    vi.stubEnv('BRAVE_API_KEY', 'brave-secret');
    vi.stubEnv('HYBRIDCLAW_GATEWAY_URL', 'http://127.0.0.1:9090');
    vi.stubEnv('HYBRIDCLAW_GATEWAY_TOKEN', 'gateway-token');
    vi.stubEnv('HYBRIDCLAW_TEST_VISIBLE', 'visible');

    const { executeTool } = await createBashTestRuntime({
      sessionId: `bash-session-sanitized-env-${Date.now()}`,
    });

    const result = await executeTool(
      'bash',
      bashCommand(
        'printf "%s|%s|%s|%s|%s|%s|%s|%s|%s|%s" "$OPENAI_API_KEY" "$ANTHROPIC_API_KEY" "$AWS_ACCESS_KEY_ID" "$AWS_SECRET_ACCESS_KEY" "$AWS_SESSION_TOKEN" "$GITHUB_TOKEN" "$BRAVE_API_KEY" "$HYBRIDCLAW_GATEWAY_URL" "$HYBRIDCLAW_GATEWAY_TOKEN" "$HYBRIDCLAW_TEST_VISIBLE"',
      ),
    );

    expect(result).toBe('|||||||http://127.0.0.1:9090|gateway-token|visible');
  });

  test('persists aliases across bash calls', async () => {
    const { executeTool } = await createBashTestRuntime({
      sessionId: `bash-session-alias-${Date.now()}`,
    });

    await executeTool('bash', bashCommand("alias ll='printf alias-ok'"));
    const result = await executeTool('bash', bashCommand('ll'));

    expect(result).toBe('alias-ok');
  });

  test('recovers by falling back to the workspace root when the saved cwd disappears', async () => {
    const { executeTool } = await createBashTestRuntime({
      nested: true,
      sessionId: `bash-session-cwd-fallback-${Date.now()}`,
    });

    const first = await executeTool(
      'bash',
      bashCommand('cd nested && printf %s "$(basename "$PWD")"'),
    );
    fs.rmSync(path.join(workspaceRoot, 'nested'), {
      recursive: true,
      force: true,
    });
    const second = await executeTool(
      'bash',
      bashCommand('printf %s "$(basename "$PWD")"'),
    );

    expect(first).toBe('nested');
    expect(second).toBe(path.basename(workspaceRoot));
  });

  test('keeps bash session state isolated when the session context changes', async () => {
    const { executeTool, setSessionContext } = await createBashTestRuntime();

    setSessionContext(`bash-session-a-${Date.now()}`);
    await executeTool(
      'bash',
      bashCommand('export HYBRIDCLAW_SESSION_ONLY=present'),
    );

    setSessionContext(`bash-session-b-${Date.now()}`);
    const result = await executeTool(
      'bash',
      bashCommand('printf %s "$HYBRIDCLAW_SESSION_ONLY"'),
    );

    expect(result).toBe('(no output)');
  });

  // A new worker for the session: fresh module state, same workspace.
  async function restartWorker(sessionId: string): Promise<ToolsModule> {
    await tools?.resetPersistentBashSessions();
    vi.resetModules();
    const restarted = await loadTools();
    restarted.setSessionContext(sessionId);
    return restarted;
  }

  function sessionCwdFiles(): string[] {
    const root = path.join(workspaceRoot, '.hybridclaw-runtime', 'sessions');
    if (!fs.existsSync(root)) return [];
    return fs
      .readdirSync(root)
      .map((key) => path.join(root, key, 'bash-cwd'))
      .filter((file) => fs.existsSync(file));
  }

  test.each([
    { removeNested: false, expectedDir: 'nested' },
    { removeNested: true, expectedDir: '' },
  ])('a restarted worker keeps the session cwd and flags the lost environment (cwd removed=$removeNested)', async ({ removeNested, expectedDir }) => {
    const sessionId = `bash-session-restart-${Date.now()}`;
    const { executeTool } = await createBashTestRuntime({ nested: true, sessionId });
    await executeTool('bash', bashCommand('cd nested && export HYBRIDCLAW_TEST_VAR=worker-one'));
    expect(sessionCwdFiles().map((file) => fs.readFileSync(file, 'utf-8').trim())).toEqual([fs.realpathSync(path.join(workspaceRoot, 'nested'))]);
    if (removeNested) fs.rmSync(path.join(workspaceRoot, 'nested'), { recursive: true });

    const restarted = await restartWorker(sessionId);
    const probe = bashCommand('printf "%s:%s" "$(basename "$PWD")" "$HYBRIDCLAW_TEST_VAR"');
    const first = await restarted.executeTool('bash', probe);
    const second = await restarted.executeTool('bash', probe);

    const dir = expectedDir || path.basename(workspaceRoot);
    const [note, output] = first.split('\n\n');
    expect(note).toMatch(/^\[.+\]$/);
    expect(output).toBe(`${dir}:`);
    expect(second).toBe(`${dir}:`);
  });

  test('a restarted worker gives other sessions a fresh shell without a note', async () => {
    const { executeTool } = await createBashTestRuntime({ nested: true, sessionId: 'bash-session-owner' });
    await executeTool('bash', bashCommand('cd nested'));

    const restarted = await restartWorker('bash-session-other');
    const result = await restarted.executeTool('bash', bashCommand('printf %s "$(basename "$PWD")"'));

    expect(result).toBe(path.basename(workspaceRoot));
  });

  test('the docker-exec sandbox keeps the session cwd in its own /tmp', async () => {
    vi.stubEnv('HYBRIDCLAW_BASH_DOCKER_CONTAINER', 'test-sandbox');
    await mockDockerSpawn('ok');
    const { executeTool } = await createBashTestRuntime({ sessionId: 'bash-session-docker' });
    expect(await executeTool('bash', bashCommand('pwd'))).toBe('ok');
    const cwdFile = stdinFields(vi.mocked(spawn).mock.calls[0][2])[2];
    expect(cwdFile.startsWith('/tmp/')).toBe(true);
    expect(sessionCwdFiles()).toEqual([]);
  });

  test('starts each bash call fresh when persistent bash state is disabled', async () => {
    const { executeTool } = await createBashTestRuntime({
      nested: true,
      persistBashState: false,
      sessionId: `bash-session-stateless-${Date.now()}`,
    });

    await executeTool(
      'bash',
      bashCommand(
        'cd nested && export HYBRIDCLAW_TEST_VAR=persisted && alias ll="printf alias-ok" && printf %s "$(basename "$PWD")"',
      ),
    );
    const second = await executeTool(
      'bash',
      bashCommand('printf %s "$(basename "$PWD"):$HYBRIDCLAW_TEST_VAR"'),
    );
    const aliasResult = await executeTool('bash', bashCommand('ll'));

    expect(second).toBe(`${path.basename(workspaceRoot)}:`);
    expect(aliasResult).toContain('command not found');
  });

  test.each([false, true])('keeps exact command contents in stdin, outside argv (persistent=%s)', async (persistBashState) => {
    const { executeTool } = await createBashTestRuntime({ persistBashState });
    const command = "  printf '%s\\n' 'quote \" and dollar $ and backtick `'\n# trailing whitespace\n\n";
    const result = await executeTool('bash', bashCommand(command));
    expect(result).toBe('quote " and dollar $ and backtick `\n');
    const call = vi.mocked(spawn).mock.calls.find(([file]) => file === 'bash');
    expect(call).toBeDefined();
    expect(call![1]).not.toContain(command);
    expect(JSON.stringify(call![1])).not.toContain('trailing whitespace');
    expect(stdinFields(call![2])).toHaveLength(persistBashState ? 6 : 2);
    expect(stdinFields(call![2]).at(-1)).toBe(command);
  });

  test.each([false, true])('child commands see EOF after the command frame (persistent=%s)', async (persistBashState) => {
    const { executeTool } = await createBashTestRuntime({ persistBashState });
    const result = await executeTool('bash', bashCommand('if IFS= read -r line; then printf unexpected-input; else printf stdin-eof; fi'));
    expect(result).toBe('stdin-eof');
    const heredoc = "cat <<'EOF'\nline one\nline two\nEOF";
    expect(await executeTool('bash', bashCommand(heredoc))).toBe('line one\nline two\n');
  });

  test.each([false, true])('preserves nonzero command status (persistent=%s)', async (persistBashState) => {
    const { executeToolWithMetadata } = await createBashTestRuntime({ persistBashState });
    const result = await executeToolWithMetadata('bash', bashCommand('printf failed; exit 7'));
    expect(result.isError).toBe(true);
    expect(result.output).toContain('exit code 7');
    expect(result.output).toContain('failed');
  });

  test.each([false, true])('rejects invalid input and blocked commands before launch (persistent=%s)', async (persistBashState) => {
    const { executeToolWithMetadata } = await createBashTestRuntime({ persistBashState });
    for (const command of [null, 123, ['printf test'], 'printf first\0printf second', 'eval "printf unsafe"']) {
      const result = await executeToolWithMetadata('bash', JSON.stringify({ command }));
      expect(result.isError).toBe(true);
    }
    expect(spawn).not.toHaveBeenCalled();
  });

  test.each([false, true])('Docker receives the same framed stdin and fixed wrapper (persistent=%s)', async (persistBashState) => {
    vi.stubEnv('HYBRIDCLAW_BASH_DOCKER_CONTAINER', 'test-sandbox');
    vi.stubEnv('HYBRIDCLAW_BASH_DOCKER_CWD', '/workspace');
    await mockDockerSpawn('sandbox-result');
    const { executeTool } = await createBashTestRuntime({ persistBashState });
    const command = 'printf approved-sandbox-command';
    expect(await executeTool('bash', bashCommand(command))).toBe('sandbox-result');
    const [file, args, options] = vi.mocked(spawn).mock.calls[0];
    expect(file).toBe('docker');
    expect(args!.slice(0, 6)).toEqual(['exec', '-i', '-w', '/workspace', 'test-sandbox', 'bash']);
    expect(args).not.toContain(command);
    expect(args!.slice(-1)).toEqual(persistBashState ? ['hybridclaw-bash-wrapper'] : [expect.any(String)]);
    expect(stdinFields(options).at(-1)).toBe(command);
  });

});
