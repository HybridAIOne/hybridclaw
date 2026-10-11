import { expect, it, vi } from 'vitest';

import { useCleanMocks } from './test-utils.js';

useCleanMocks({ resetModules: true });

async function importToolCommand(disabled: string[] = []) {
  const updateRuntimeConfig = vi.fn();
  const setRuntimeToolEnabled = vi.fn();
  vi.doMock('../src/config/runtime-config.js', () => ({
    getRuntimeConfig: vi.fn(() => ({})),
    getRuntimeDisabledToolNames: vi.fn(() => new Set(disabled)),
    setRuntimeToolEnabled,
    updateRuntimeConfig: vi.fn((mutate: (draft: object) => void) => {
      mutate({});
      updateRuntimeConfig();
    }),
  }));
  vi.doMock('../src/plugins/plugin-manager.js', () => ({
    ensurePluginManagerInitialized: vi.fn(async () => ({
      getToolDefinitions: () => [{ name: 'plugin_tool' }],
    })),
  }));
  const { handleToolCommand } = await import('../src/cli/tool-command.js');
  return { handleToolCommand, setRuntimeToolEnabled };
}

it.each([
  'diagram_create',
  'browser_await_two_factor',
  'plugin_tool',
])('disables %s', async (toolName) => {
  const { handleToolCommand, setRuntimeToolEnabled } =
    await importToolCommand();
  vi.spyOn(console, 'log').mockImplementation(() => {});

  await handleToolCommand(['disable', toolName]);

  expect(setRuntimeToolEnabled).toHaveBeenCalledWith({}, toolName, false);
});

it.each(['react', 'image_generate'])('rejects %s', async (toolName) => {
  const { handleToolCommand, setRuntimeToolEnabled } =
    await importToolCommand();

  await expect(handleToolCommand(['disable', toolName])).rejects.toThrow(
    `Unknown tool: ${toolName}`,
  );
  expect(setRuntimeToolEnabled).not.toHaveBeenCalled();
});

it('lists built-in and plugin tools with their state', async () => {
  const { handleToolCommand } = await importToolCommand(['plugin_tool']);
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

  await handleToolCommand(['list']);

  const lines = logSpy.mock.calls.map(([line]) => line);
  expect(lines).toContain('diagram_validate [enabled]');
  expect(lines).toContain('plugin_tool [disabled]');
});
