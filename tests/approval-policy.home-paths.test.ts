import path from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { TrustedAgentApprovalRuntime } from '../container/src/approval-policy.js';
import { useCleanMocks, useTempDir } from './test-utils.js';

const makeTempDir = useTempDir('hybridclaw-home-path-');
useCleanMocks({ unstubAllEnvs: true });

describe('workspace fence for home-relative bash writes', () => {
  test.each([
    { home: '/home/user_a', actionKey: 'bash:workspace-fence', decision: 'required' },
    { home: '/workspace', actionKey: 'bash:write-op', decision: 'implicit' },
    { home: '/tmp/home', actionKey: 'bash:write-op', decision: 'implicit' },
  ])('resolves home paths against $home', ({ home, actionKey, decision }) => {
    // The suite setup isolates HOME under /tmp, an allowed scratch root.
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);

    const dir = makeTempDir();
    const runtime = new TrustedAgentApprovalRuntime(
      path.join(dir, 'missing-policy.yaml'),
      path.join(dir, 'agent-trust.json'),
      path.join(dir, 'all-trust.json'),
      path.join(dir, 'legacy-trust.json'),
      undefined,
      path.join(dir, 'pending.json'),
    );

    for (const target of ['~/out.txt', '$HOME/out.txt', '${HOME}/out.txt']) {
      const evaluation = runtime.evaluateToolCall({
        toolName: 'bash',
        argsJson: JSON.stringify({ command: `echo x > ${target}` }),
        latestUserPrompt: 'Write the output file',
      });

      expect(evaluation, target).toMatchObject({ actionKey, decision });
    }
  });
});
