import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return { ...original, spawnSync: vi.fn(original.spawnSync) };
});

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

  afterEach(() => {
    tools?.resetPersistentBashSessions();
    tools = null;
    vi.mocked(spawnSync).mockReset();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.resetModules();
    if (workspaceRoot) {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
      workspaceRoot = '';
    }
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
    const call = vi.mocked(spawnSync).mock.calls.find(([file]) => file === 'bash');
    expect(call).toBeDefined();
    expect(call![1]).not.toContain(command);
    expect(JSON.stringify(call![1])).not.toContain('trailing whitespace');
    expect(call![2]).toMatchObject({ input: `${command}\0` });
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
    expect(spawnSync).not.toHaveBeenCalled();
  });

  test.each([false, true])('Docker receives the same framed stdin and fixed wrapper (persistent=%s)', async (persistBashState) => {
    vi.stubEnv('HYBRIDCLAW_BASH_DOCKER_CONTAINER', 'test-sandbox');
    vi.stubEnv('HYBRIDCLAW_BASH_DOCKER_CWD', '/workspace');
    vi.mocked(spawnSync).mockReturnValue({ pid: 1, status: 0, signal: null, stdout: 'sandbox-result', stderr: '', output: ['', 'sandbox-result', ''] });
    const { executeTool } = await createBashTestRuntime({ persistBashState });
    const command = 'printf approved-sandbox-command';
    expect(await executeTool('bash', bashCommand(command))).toBe('sandbox-result');
    const [file, args, options] = vi.mocked(spawnSync).mock.calls[0];
    expect(file).toBe('docker');
    expect(args!.slice(0, 6)).toEqual(['exec', '-i', '-w', '/workspace', 'test-sandbox', 'bash']);
    expect(args).not.toContain(command);
    expect(options).toMatchObject({ input: `${command}\0` });
  });

});
