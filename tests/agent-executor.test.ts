import { afterEach, expect, test, vi } from 'vitest';
import { setSandboxModeOverride } from '../src/config/config.js';

afterEach(() => {
  setSandboxModeOverride(null);
  vi.resetModules();
  vi.clearAllMocks();
});

function makeExecutor(kind: string, workspacePath: string) {
  return {
    kind,
    exec: vi.fn(),
    getWorkspacePath: vi.fn(() => workspacePath),
    stopSession: vi.fn(() => false),
    stopAll: vi.fn(),
    getActiveSessionCount: vi.fn(() => 0),
    getActiveSessionIds: vi.fn(() => []),
  };
}

test('getExecutor honors per-request host override when global mode is container', async () => {
  setSandboxModeOverride('container');

  const containerExecutor = makeExecutor('container', '/container-workspace');
  const hostExecutor = makeExecutor('host', '/host-workspace');
  const ContainerExecutor = vi
    .fn()
    .mockImplementation(function MockContainerExecutor() {
      return containerExecutor;
    });
  const HostExecutor = vi.fn().mockImplementation(function MockHostExecutor() {
    return hostExecutor;
  });

  vi.doMock('../src/infra/container-runner.js', () => ({
    ContainerExecutor,
  }));
  vi.doMock('../src/infra/host-runner.js', () => ({
    HostExecutor,
  }));

  const { getExecutor } = await import('../src/agent/executor.js');

  expect(getExecutor().getWorkspacePath('main')).toBe('/container-workspace');
  expect(getExecutor('host').getWorkspacePath('main')).toBe('/host-workspace');
});
