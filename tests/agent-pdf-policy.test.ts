import { expect, test, vi } from 'vitest';
import type { ExecutorRequest } from '../src/agent/executor-types.js';
import { useCleanMocks, useTempDir } from './test-utils.js';

const tempDir = useTempDir();
useCleanMocks({
  resetModules: true,
  unmock: [
    '../src/agent/executor.js',
    '../src/security/confidential-runtime.js',
    '../src/providers/model-catalog.js',
  ],
});

test.each([
  { confidential: true, acceptsVisual: true, allowed: false },
  { confidential: true, acceptsVisual: false, allowed: false },
  { confidential: false, acceptsVisual: false, allowed: true },
  { confidential: false, acceptsVisual: true, allowed: true },
])(
  'gateway PDF media policy %j',
  async ({ confidential, acceptsVisual, allowed }) => {
    const root = tempDir();
    const exec = vi.fn(async (_request: ExecutorRequest) => ({
      status: 'success',
      result: 'ok',
      toolsUsed: [],
    }));
    vi.doMock('../src/agent/executor.js', () => ({
      getExecutor: () => ({ exec, getWorkspacePath: () => root }),
    }));
    vi.doMock('../src/providers/model-catalog.js', () => ({
      canModelAcceptVisualMedia: async () => acceptsVisual,
    }));
    vi.doMock('../src/security/confidential-runtime.js', async (original) => ({
      ...(await original<
        typeof import('../src/security/confidential-runtime.js')
      >()),
      isConfidentialRedactionEnabled: () => confidential,
      getConfidentialRuleSet: () => ({ rules: [], sourcePath: null }),
    }));
    const { runAgent } = await import('../src/agent/agent.js');
    await runAgent({
      sessionId: 'pdf-policy',
      chatbotId: '',
      enableRag: false,
      model: 'test-model',
      messages: [{ role: 'user', content: 'Hello' }],
      // A caller cannot override the gateway confidentiality decision.
      visualMediaAllowed: !allowed,
      primaryModelSupportsVisualMedia: !acceptsVisual,
    });
    expect(exec.mock.calls[0][0].visualMediaAllowed).toBe(allowed);
    expect(exec.mock.calls[0][0].primaryModelSupportsVisualMedia).toBe(
      acceptsVisual,
    );
  },
);
