import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

describe.sequential('container bash tool persistence', () => {
  let workspaceRoot = '';

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.resetModules();
    if (workspaceRoot) {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
      workspaceRoot = '';
    }
  });

  test('persists cwd across bash calls in the same session', async () => {
    workspaceRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-bash-tool-'),
    );
    fs.mkdirSync(path.join(workspaceRoot, 'nested'), { recursive: true });
    vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', workspaceRoot);

    const { executeTool, setSessionContext } = await import(
      '../container/src/tools.js'
    );
    setSessionContext(`bash-session-cd-${Date.now()}`);

    const first = await executeTool(
      'bash',
      JSON.stringify({ command: 'cd nested && printf %s "$(basename "$PWD")"' }),
    );
    const second = await executeTool(
      'bash',
      JSON.stringify({ command: 'printf %s "$(basename "$PWD")"' }),
    );

    expect(first).toBe('nested');
    expect(second).toBe('nested');
  });

  test('persists exported environment variables across bash calls', async () => {
    workspaceRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-bash-tool-'),
    );
    vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', workspaceRoot);

    const { executeTool, setSessionContext } = await import(
      '../container/src/tools.js'
    );
    setSessionContext(`bash-session-env-${Date.now()}`);

    await executeTool(
      'bash',
      JSON.stringify({ command: 'export HYBRIDCLAW_TEST_VAR=persisted' }),
    );
    const result = await executeTool(
      'bash',
      JSON.stringify({ command: 'printf %s "$HYBRIDCLAW_TEST_VAR"' }),
    );

    expect(result).toBe('persisted');
  });

  test('persists aliases across bash calls', async () => {
    workspaceRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-bash-tool-'),
    );
    vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', workspaceRoot);

    const { executeTool, setSessionContext } = await import(
      '../container/src/tools.js'
    );
    setSessionContext(`bash-session-alias-${Date.now()}`);

    await executeTool(
      'bash',
      JSON.stringify({ command: "alias ll='printf alias-ok'" }),
    );
    const result = await executeTool('bash', JSON.stringify({ command: 'll' }));

    expect(result).toBe('alias-ok');
  });

  test('keeps bash session state isolated by session id', async () => {
    workspaceRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-bash-tool-'),
    );
    vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', workspaceRoot);

    const { executeTool, setSessionContext } = await import(
      '../container/src/tools.js'
    );

    setSessionContext(`bash-session-a-${Date.now()}`);
    await executeTool(
      'bash',
      JSON.stringify({ command: 'export HYBRIDCLAW_SESSION_ONLY=present' }),
    );

    setSessionContext(`bash-session-b-${Date.now()}`);
    const result = await executeTool(
      'bash',
      JSON.stringify({ command: 'printf %s "$HYBRIDCLAW_SESSION_ONLY"' }),
    );

    expect(result).toBe('(no output)');
  });
});
