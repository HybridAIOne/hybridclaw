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
    '../src/providers/model-metadata.js',
  ],
});

test.each([
  { confidential: true, known: true, vision: true, allowed: false },
  { confidential: false, known: true, vision: false, allowed: false },
  { confidential: false, known: true, vision: true, allowed: true },
  { confidential: false, known: false, vision: false, allowed: true },
])(
  'gateway PDF media policy %j',
  async ({ confidential, known, vision, allowed }) => {
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
      isModelVisionCapable: () => vision,
    }));
    vi.doMock('../src/providers/model-metadata.js', () => ({
      resolveStaticModelCatalogMetadata: () => ({ known }),
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
    });
    expect(exec.mock.calls[0][0].visualMediaAllowed).toBe(allowed);
  },
);
