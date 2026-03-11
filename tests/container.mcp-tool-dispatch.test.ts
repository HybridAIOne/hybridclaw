import { afterEach, describe, expect, test, vi } from 'vitest';

describe.sequential('container MCP tool dispatch', () => {
  afterEach(async () => {
    const { setMcpClientManager } = await import('../container/src/tools.js');
    setMcpClientManager(null);
    vi.restoreAllMocks();
    vi.resetModules();
  });

  test('rejects non-object JSON arguments for MCP tools', async () => {
    const { executeTool, setMcpClientManager } = await import(
      '../container/src/tools.js'
    );
    const callToolDetailed = vi.fn();
    setMcpClientManager({
      isKnownTool: vi.fn().mockReturnValue(true),
      callToolDetailed,
    } as never);

    const result = await executeTool('demo__echo', '[]');

    expect(result).toBe('Error: MCP tool arguments must be a JSON object');
    expect(callToolDetailed).not.toHaveBeenCalled();
  });

  test('passes object JSON arguments through to the MCP manager', async () => {
    const { executeTool, setMcpClientManager } = await import(
      '../container/src/tools.js'
    );
    const callToolDetailed = vi
      .fn()
      .mockResolvedValue({ output: 'ok', isError: false });
    setMcpClientManager({
      isKnownTool: vi.fn().mockReturnValue(true),
      callToolDetailed,
    } as never);

    const result = await executeTool(
      'demo__echo',
      JSON.stringify({ value: 'hello' }),
    );

    expect(result).toBe('ok');
    expect(callToolDetailed).toHaveBeenCalledWith('demo__echo', {
      value: 'hello',
    });
  });
});
