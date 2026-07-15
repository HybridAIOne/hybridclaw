import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

describe.sequential('container tool execution policy', () => {
  let workspaceRoot = '';

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.resetModules();
    if (workspaceRoot) {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
      workspaceRoot = '';
    }
  });

  test('updates allowlist policy between requests and preserves undefined versus empty semantics', async () => {
    workspaceRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-tool-policy-'),
    );
    vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', workspaceRoot);

    const { executeToolWithMetadata, setToolExecutionPolicy } = await import(
      '../container/src/tools.js'
    );

    setToolExecutionPolicy(undefined, undefined);
    const unrestricted = await executeToolWithMetadata(
      'write',
      JSON.stringify({ path: 'unrestricted.txt', contents: 'allowed' }),
    );

    setToolExecutionPolicy([], undefined);
    const denied = await executeToolWithMetadata(
      'write',
      JSON.stringify({ path: 'denied.txt', contents: 'must not be written' }),
    );

    setToolExecutionPolicy(['write'], undefined);
    const explicitlyAllowed = await executeToolWithMetadata(
      'write',
      JSON.stringify({ path: 'allowed.txt', contents: 'allowed again' }),
    );

    expect(unrestricted.isError).toBe(false);
    expect(denied).toEqual({
      output: 'Error: tool "write" is disabled for this request.',
      isError: true,
    });
    expect(explicitlyAllowed.isError).toBe(false);
    expect(fs.existsSync(path.join(workspaceRoot, 'unrestricted.txt'))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(workspaceRoot, 'denied.txt'))).toBe(false);
    expect(fs.existsSync(path.join(workspaceRoot, 'allowed.txt'))).toBe(true);
  });

  test('blocked tools override the allowlist before built-in execution', async () => {
    workspaceRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-tool-policy-'),
    );
    vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', workspaceRoot);

    const { executeToolWithMetadata, setToolExecutionPolicy } = await import(
      '../container/src/tools.js'
    );
    setToolExecutionPolicy(['write'], ['write']);

    const result = await executeToolWithMetadata(
      'write',
      JSON.stringify({ path: 'blocked.txt', contents: 'must not be written' }),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain('disabled for this request');
    expect(fs.existsSync(path.join(workspaceRoot, 'blocked.txt'))).toBe(false);
  });

  test('blocks plugin dispatch without calling the gateway', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const {
      executeToolWithMetadata,
      setGatewayContext,
      setPluginTools,
      setToolExecutionPolicy,
    } = await import('../container/src/tools.js');
    setGatewayContext('http://127.0.0.1:9000', 'test-token', 'web', []);
    setPluginTools([
      {
        name: 'plugin__dangerous',
        description: 'Test plugin tool',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    ]);
    setToolExecutionPolicy(undefined, ['plugin__dangerous']);

    const result = await executeToolWithMetadata('plugin__dangerous', '{}');

    expect(result.isError).toBe(true);
    expect(result.output).toContain('disabled for this request');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('blocks MCP dispatch without calling the MCP manager', async () => {
    const isKnownTool = vi.fn(() => true);
    const callToolDetailed = vi.fn(async () => ({
      output: 'must not run',
      isError: false,
    }));
    const {
      executeToolWithMetadata,
      setMcpClientManager,
      setToolExecutionPolicy,
    } = await import('../container/src/tools.js');
    setMcpClientManager({
      isKnownTool,
      callToolDetailed,
    } as unknown as Parameters<typeof setMcpClientManager>[0]);
    setToolExecutionPolicy(undefined, ['mcp__dangerous']);

    const result = await executeToolWithMetadata('mcp__dangerous', '{}');

    expect(result.isError).toBe(true);
    expect(result.output).toContain('disabled for this request');
    expect(isKnownTool).not.toHaveBeenCalled();
    expect(callToolDetailed).not.toHaveBeenCalled();
  });
});
