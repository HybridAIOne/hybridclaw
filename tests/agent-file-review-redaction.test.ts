import path from 'node:path';
import { expect, test, vi } from 'vitest';
import type { ExecutorRequest } from '../src/agent/executor-types.js';
import { cleanupGatewayRuntime } from './helpers/gateway-test-setup.js';
import { useCleanMocks, useTempDir } from './test-utils.js';

const temporary = useTempDir('review-redaction-');
useCleanMocks({
  cleanup: cleanupGatewayRuntime,
  resetModules: true,
  unmock: [
    '../src/agent/executor.js',
    '../src/providers/model-catalog.js',
    '../src/security/confidential-runtime.js',
  ],
});

test.each([true, false])(
  'root review intent follows the existing confidentiality setting: %s',
  async (enabled) => {
    const root = temporary();
    const { initDatabase } = await import('../src/memory/db.js');
    initDatabase({ dbPath: path.join(root, 'review.db'), quiet: true });
    const exec = vi.fn(async (_request: ExecutorRequest) => ({
      status: 'success',
      result: 'Done.',
      toolsUsed: [],
      fileWriteGuardUserPrompt: _request.fileWriteGuardUserPrompt,
      sideEffects: {
        delegations: [{ action: 'delegate', prompt: 'Inspect fixture.' }],
      },
    }));
    vi.doMock('../src/agent/executor.js', () => ({
      getExecutor: () => ({ exec, getWorkspacePath: () => root }),
    }));
    vi.doMock('../src/providers/model-catalog.js', () => ({
      canModelAcceptVisualMedia: async () => false,
    }));
    const { parseConfidentialYaml } = await import(
      '../src/security/confidential-rules.js'
    );
    const rules = parseConfidentialYaml(
      'clients:\n  - name: Example Orchard\n    sensitivity: medium\n',
    );
    vi.doMock('../src/security/confidential-runtime.js', async (original) => ({
      ...(await original<
        typeof import('../src/security/confidential-runtime.js')
      >()),
      isConfidentialRedactionEnabled: () => enabled,
      getConfidentialRuleSet: () => rules,
    }));
    const { runAgent } = await import('../src/agent/agent.js');
    const prompt = 'Update the Example Orchard report.';
    const output = await runAgent({
      sessionId: 'review-redaction',
      chatbotId: '',
      enableRag: false,
      model: 'test-model',
      fileWriteGuardUserPrompt: prompt,
      messages: [{ role: 'user', content: prompt }],
    });
    expect(output.fileWriteGuardUserPrompt).toBe(prompt);
    const input = exec.mock.calls[0][0];
    expect(input.fileWriteGuardUserPrompt).toBe(input.messages[0].content);
    if (enabled) {
      expect(input.fileWriteGuardUserPrompt).not.toContain('Example Orchard');
      expect(input.fileWriteGuardUserPrompt).toContain('«CONF:');
    } else expect(input.fileWriteGuardUserPrompt).toBe(prompt);
  },
);
