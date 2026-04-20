import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

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
    const second = await executeTool('bash', bashCommand('printf %s "$(basename "$PWD")"'));

    expect(first).toBe('nested');
    expect(second).toBe('nested');
  });

  test('persists exported environment variables across bash calls', async () => {
    const { executeTool } = await createBashTestRuntime({
      sessionId: `bash-session-env-${Date.now()}`,
    });

    await executeTool('bash', bashCommand('export HYBRIDCLAW_TEST_VAR=persisted'));
    const result = await executeTool(
      'bash',
      bashCommand('printf %s "$HYBRIDCLAW_TEST_VAR"'),
    );

    expect(result).toBe('persisted');
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
});
