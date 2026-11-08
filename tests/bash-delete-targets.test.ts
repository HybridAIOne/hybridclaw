import path from 'node:path';
import { expect, test } from 'vitest';
import { TrustedAgentApprovalRuntime } from '../container/src/approval-policy.js';
import {
  scriptCommands,
  writeTargets,
} from '../container/src/bash-commands.js';
import { useTempDir } from './test-utils.js';

const temp = useTempDir('hc-delete-targets-');
function evaluate(command: string) {
  const runtime = new TrustedAgentApprovalRuntime(
    path.join(temp(), 'policy.yaml'),
  );
  runtime.setApprovalMode({ mode: 'full' });
  return runtime.evaluateToolCall({
    toolName: 'bash',
    argsJson: JSON.stringify({ command }),
  });
}

test.each(
  [
    'rm -f /opt/data/notes.txt',
    'unlink /opt/data/notes.txt',
    'env -u FEATURE rm -- /opt/data/notes.txt',
    'rm -f /opt/data/notes.txt "$OTHER"',
    'cd /opt/data && rm -f notes.txt',
    'printf sample | xargs rm -f /opt/data/notes.txt',
    "find . -name '*.log' -exec rm -f /opt/data/notes.txt {} \\;",
    "sh -c 'rm -f /opt/data/notes.txt'",
  ].flatMap((command) => [
    `${command} > /tmp/cleanup.log`,
    `${command} > cleanup.log 2>&1`,
    `${command} 2>/dev/null`,
  ]),
)(
  'redirects do not hide deletion targets from the workspace fence: %s',
  (command) => {
    expect(evaluate(command)).toMatchObject({
      actionKey: 'bash:workspace-fence',
      decision: 'required',
      writeIntent: true,
    });
  },
);

test.each([
  'rm -f notes.txt > /tmp/cleanup.log',
  'unlink notes.txt > cleanup.log',
  'cd /tmp && rm -f notes.txt > cleanup.log',
  'cat /opt/data/notes.txt > /tmp/cleanup.log',
  'python3 /opt/tools/report.py > /tmp/cleanup.log',
])(
  'workspace deletions and outside reads retain their existing capability: %s',
  (command) => {
    expect(evaluate(command).actionKey).not.toBe('bash:workspace-fence');
  },
);

test('a dynamic deletion operand does not erase a known outside target', () => {
  expect(
    writeTargets(
      scriptCommands(
        'rm -f /opt/data/notes.txt "$OTHER" > /tmp/cleanup.log',
        '/workspace',
      ),
    ),
  ).toContain('/opt/data/notes.txt');
});
