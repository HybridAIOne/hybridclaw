import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.js';

const tempDir = useTempDir();
useCleanMocks({ unstubAllEnvs: true, resetModules: true });

test('host state belongs to the selected agent or scope independently of the task path', async () => {
  vi.stubEnv('HYBRIDCLAW_DATA_DIR', tempDir());
  const { hostWorkspaceStateRoot } = await import(
    '../src/infra/host-workspace.js'
  );
  const { agentWorkspaceDir } = await import('../src/infra/ipc.js');
  const { scopeWorkspaceDir } = await import('../src/scopes/scope-paths.js');
  expect(hostWorkspaceStateRoot({ agentId: 'agent-a' })).toBe(
    path.resolve(agentWorkspaceDir('agent-a')),
  );
  const roots = ['s_aaaaaaaaaaaa', 's_bbbbbbbbbbbb'].map((scopeId) =>
    hostWorkspaceStateRoot({
      agentId: 'agent-a',
      runtimeScope: { agentId: 'agent-a', scopeId },
    }),
  );
  expect(roots[0]).toBe(
    path.resolve(scopeWorkspaceDir('agent-a', 's_aaaaaaaaaaaa')),
  );
  expect(
    new Set([
      ...roots,
      hostWorkspaceStateRoot({ agentId: 'agent-a' }),
      hostWorkspaceStateRoot({ agentId: 'agent-b' }),
    ]).size,
  ).toBe(4);
  expect(() =>
    hostWorkspaceStateRoot({
      agentId: 'agent-a',
      runtimeScope: { agentId: 'agent-b', scopeId: 's_aaaaaaaaaaaa' },
    }),
  ).toThrow('belong');
});
