import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.js';

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  spawn.mockImplementation(actual.spawnSync);
  return { ...actual, spawnSync: spawn };
});
const temporary = useTempDir('xml-parser-failure-');
useCleanMocks({
  resetModules: true,
  unstubAllEnvs: true,
  cleanup: () => spawn.mockReset(),
});

const parserFailures = [
  [
    'missing interpreter',
    {
      status: null,
      error: Object.assign(new Error('Unavailable'), { code: 'ENOENT' }),
      stdout: '',
    },
  ],
  [
    'timeout',
    {
      status: null,
      error: Object.assign(new Error('Timed out'), { code: 'ETIMEDOUT' }),
      stdout: '',
    },
  ],
  ['nonzero exit', { status: 1, stdout: '' }],
  ['malformed response', { status: 0, stdout: 'malformed' }],
  ['missing response', { status: 0, stdout: null }],
  ['invalid response shape', { status: 0, stdout: '{}' }],
] as const;

test.each(parserFailures)(
  'an XML %s keeps the full approval boundary and does not poison recovery',
  async (_label, failure) => {
    const root = temporary();
    vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', root);
    vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_DISPLAY_ROOT', '/workspace');
    vi.stubEnv('HYBRIDCLAW_AGENT_STATE_ROOT', root);
    const { TrustedAgentApprovalRuntime } = await import(
      '../container/src/approval-policy.js'
    );
    const runtime = new TrustedAgentApprovalRuntime(
      path.join(root, 'policy.yaml'),
    );
    runtime.setSession('xml-failure');
    runtime.setApprovalMode({ mode: 'full' });
    const evaluate = (command: string) =>
      runtime.evaluateToolCall({
        toolName: 'bash',
        argsJson: JSON.stringify({ command }),
        latestUserPrompt: 'Read the synthetic feed.',
      });
    runtime.afterToolExecution(
      evaluate('curl -o feed.xml https://example.com/feed'),
      true,
    );
    const command = `python3 -c 'import xml.etree.ElementTree as ET; print(ET.parse("feed.xml").getroot().text)'`;
    spawn.mockClear();
    spawn.mockReturnValue(failure);
    const blocked = evaluate(command);
    expect(blocked).toMatchObject({
      actionKey: 'bash:fetched-code',
      tier: 'red',
      decision: 'required',
    });
    expect(spawn).toHaveBeenCalledOnce();
    const options = spawn.mock.calls[0][2];
    expect(options.timeout).toBeGreaterThan(0);
    expect(options.timeout).toBeLessThanOrEqual(1000);
    expect(spawn.mock.calls[0][1]).toEqual(
      expect.arrayContaining(['-I', '-S', '-B']),
    );
    const actual =
      await vi.importActual<typeof import('node:child_process')>(
        'node:child_process',
      );
    spawn.mockImplementation(actual.spawnSync);
    spawn.mockClear();
    const recovered = evaluate(command);
    expect(recovered).toMatchObject({
      decision: 'approved_fullauto',
      pinned: false,
    });
    expect(fs.existsSync(path.join(root, 'feed.xml'))).toBe(false);
  },
);
