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
    const callTool = vi.fn();
    setMcpClientManager({
      isKnownTool: vi.fn().mockReturnValue(true),
      callTool,
    } as never);

    const result = await executeTool('demo__echo', '[]');

    expect(result).toBe('Error: MCP tool arguments must be a JSON object');
    expect(callTool).not.toHaveBeenCalled();
  });

  test('passes object JSON arguments through to the MCP manager', async () => {
    const { executeTool, setMcpClientManager } = await import(
      '../container/src/tools.js'
    );
    const callTool = vi.fn().mockResolvedValue('ok');
    setMcpClientManager({
      isKnownTool: vi.fn().mockReturnValue(true),
      callTool,
    } as never);

    const result = await executeTool(
      'demo__echo',
      JSON.stringify({ value: 'hello' }),
    );

    expect(result).toBe('ok');
    expect(callTool).toHaveBeenCalledWith('demo__echo', { value: 'hello' });
  });
});
