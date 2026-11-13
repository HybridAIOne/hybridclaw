import { expect, test, vi } from 'vitest';
import type { ExecutorRequest } from '../src/agent/executor-types.js';
import { useCleanMocks, useTempDir } from './test-utils.js';

const tempDir = useTempDir('agent-deadline-');
useCleanMocks({
  resetModules: true,
  restoreAllMocks: true,
  unstubAllEnvs: true,
  unmock: ['../src/agent/executor.js', '../src/providers/model-catalog.js'],
});

test.each([
  'initially expired',
  'expires in preparation',
  'active',
  'no bound',
] as const)(
  'agent dispatch with %s preserves the original preparation budget',
  async (phase) => {
    const root = tempDir();
    vi.stubEnv('HOME', root);
    const initial = Date.now(),
      deadline = initial + 60_000;
    const exec = vi.fn(async (_params: ExecutorRequest) => ({
      status: 'success' as const,
      result: 'Complete.',
      toolsUsed: [],
    }));
    const capabilities = vi.fn(async () => {
      vi.spyOn(Date, 'now').mockReturnValue(
        phase === 'expires in preparation' ? deadline + 1 : initial + 200,
      );
      return false;
    });
    vi.doMock('../src/agent/executor.js', () => ({
      getExecutor: () => ({ exec, getWorkspacePath: () => root }),
    }));
    vi.doMock('../src/providers/model-catalog.js', () => ({
      canModelAcceptVisualMedia: capabilities,
    }));
    const { runAgent } = await import('../src/agent/agent.js');
    const output = await runAgent({
      sessionId: 'synthetic',
      messages: [{ role: 'user', content: 'Read synthetic notes.' }],
      chatbotId: '',
      enableRag: false,
      model: 'test-model',
      ...(phase === 'no bound'
        ? {}
        : {
            executionDeadlineAtMs:
              phase === 'initially expired' ? initial - 1 : deadline,
            maxWallClockMs: 60_000,
          }),
    });
    if (phase === 'initially expired' || phase === 'expires in preparation') {
      expect(exec).not.toHaveBeenCalled();
      expect(output.status).toBe('error');
      expect(output.error).toContain('deadline exceeded');
      expect(output.tokenUsage?.modelCalls).toBe(0);
      expect(capabilities).toHaveBeenCalledTimes(
        phase === 'initially expired' ? 0 : 1,
      );
    } else {
      expect(output.status).toBe('success');
      expect(exec).toHaveBeenCalledOnce();
      expect(exec.mock.calls[0][0].executionDeadlineAtMs).toBe(
        phase === 'no bound' ? undefined : deadline,
      );
    }
  },
);
