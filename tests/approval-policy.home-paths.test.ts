import path from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { TrustedAgentApprovalRuntime } from '../container/src/approval-policy.js';
import { useCleanMocks, useTempDir } from './test-utils.js';

const makeTempDir = useTempDir('hybridclaw-home-path-');
useCleanMocks({ unstubAllEnvs: true });

function classify(command: string, home: string) {
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  const dir = makeTempDir();
  return new TrustedAgentApprovalRuntime(
    path.join(dir, 'missing-policy.yaml'),
    path.join(dir, 'agent-trust.json'),
    path.join(dir, 'all-trust.json'),
    path.join(dir, 'legacy-trust.json'),
    undefined,
    path.join(dir, 'pending.json'),
  ).evaluateToolCall({
    toolName: 'bash',
    argsJson: JSON.stringify({ command }),
    latestUserPrompt: 'Write the output file',
  });
}

describe('workspace fence for home-relative bash writes', () => {
  test.each([
    {
      home: '/home/user_a',
      actionKey: 'bash:workspace-fence',
      decision: 'required',
    },
    { home: '/workspace', actionKey: 'bash:write-op', decision: 'implicit' },
    { home: '/tmp/home', actionKey: 'bash:write-op', decision: 'implicit' },
  ])('resolves home paths against $home', ({ home, actionKey, decision }) => {
    for (const target of ['~/out.txt', '$HOME/out.txt', '${HOME}/out.txt']) {
      const evaluation = classify(`echo x > ${target}`, home);
      expect(evaluation, target).toMatchObject({ actionKey, decision });
    }
  });

  const setup = [
    'set -eu',
    'scratch=$(mktemp -d /tmp/example.XXXXXX); echo "scratch=$scratch"',
    'export HOME=$scratch/home; mkdir -p "$HOME"',
  ].join('\n');

  test.each([
    setup,
    setup
      .replace('HOME=$scratch/home', 'HOME="${scratch}/config"')
      .replace('"$HOME"', '"${HOME}"'),
  ])('uses the newly created scratch home for its initial mkdir', (setup) => {
    const command = `${setup}\ngit config --global user.name Example\necho ready > /tmp/example-ready`;
    expect(classify(command, '/root').actionKey).not.toBe(
      'bash:workspace-fence',
    );
  });

  test.each([
    ['explicit outside write', `${setup}\nmkdir -p /opt/example`],
    ['additional mkdir operand', `${setup} /opt/example`],
    ['outside redirect', `${setup} > /opt/example`],
    ['unquoted home', setup.replace('"$HOME"', '$HOME')],
    ['reassigned home', `${setup}\nexport HOME=/root; mkdir -p "$HOME"`],
    ['unknown allocator', setup.replace('mktemp -d', 'custom-allocator')],
    ['conditional setup', `if false; then\n${setup}\nfi\nmkdir -p "$HOME"`],
    ['subshell setup', `(\n${setup}\n)\nmkdir -p "$HOME"`],
    [
      'prefix assignment in a pipeline',
      setup.replace(
        'export HOME=$scratch/home;',
        'export HOME=$scratch/home | cat;',
      ),
    ],
    ['outside scratch root', setup.replace('/tmp/example.', '/opt/example.')],
    ['parent traversal', setup.replace('/home;', '/../../root;')],
  ])('still fences %s', (_label, command) => {
    expect(classify(command, '/root')).toMatchObject({
      actionKey: 'bash:workspace-fence',
      decision: 'required',
    });
  });
});
