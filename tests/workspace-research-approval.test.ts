import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.js';

const makeTempDir = useTempDir('hybridclaw-research-approval-');
useCleanMocks({ restoreAllMocks: true, resetModules: true, unstubAllEnvs: true });

test.each(['auto', 'full'] as const)(
  'scoped research reads skip protected files while shell and explicit reads remain gated (%s)',
  async (mode) => {
    const root = makeTempDir();
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(path.join(workspace, 'memory'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'memory', 'notes.md'), 'conference plan');
    const protectedPath = path.join(workspace, 'memory', '.env.local');
    fs.writeFileSync(protectedPath, 'TOKEN=conference-test-key');
    vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', workspace);

    const { TrustedAgentApprovalRuntime } = await import(
      '../container/src/approval-policy.js'
    );
    const { runGrepSearch } = await import(
      '../container/src/tools/search-tools.js'
    );
    const runtime = new TrustedAgentApprovalRuntime(
      path.join(root, 'policy.yaml'),
      path.join(root, 'agent-trust.json'),
      path.join(root, 'all-trust.json'),
      path.join(root, 'legacy-trust.json'),
      undefined,
      path.join(root, 'pending.json'),
    );
    runtime.setApprovalMode({ mode });
    const evaluate = (toolName: string, args: Record<string, unknown>) =>
      runtime.evaluateToolCall({
        toolName,
        argsJson: JSON.stringify(args),
        latestUserPrompt: 'Prepare a conference plan from the workspace notes.',
      });

    const args = { pattern: 'conference', path: 'memory' };
    expect(evaluate('grep', args)).toMatchObject({
      decision: 'auto',
      pinned: false,
    });
    const reads = vi.spyOn(fs, 'readFileSync');
    const result = runGrepSearch(args);
    expect(result.isError).toBe(false);
    expect(result.output).toContain('memory/notes.md:1:> conference plan');
    expect(result.output).not.toContain('conference-test-key');
    expect(reads.mock.calls.map(([file]) => String(file))).not.toContain(
      protectedPath,
    );

    for (const [tool, params] of [
      ['bash', { command: 'ls reports; grep -ril conference memory | head' }],
      ['grep', { ...args, path: 'memory/.env.local' }],
      ['grep', { ...args, include: '.env*' }],
    ] as const) {
      expect(evaluate(tool, params)).toMatchObject({
        decision: 'required',
        pinned: true,
      });
    }
  },
);
