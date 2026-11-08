import path from 'node:path';
import { expect, test } from 'vitest';
import { TrustedAgentApprovalRuntime } from '../container/src/approval-policy.js';
import { sedWriteTargets } from '../container/src/bash-sed-targets.js';
import { useTempDir } from './test-utils.js';

const temp = useTempDir('hc-sed-targets-');

test.each(['$&', "$'", '$`', '$$'])(
  'backup substitution treats filename characters literally: %s',
  (file) => {
    expect(sedWriteTargets('gsed', ['-ibackup-*', 's/a/b/', file])).toEqual([
      file,
      'backup-' + file,
    ]);
  },
);

test('replacement syntax cannot inflate a backup name beyond its predicted size', () => {
  const suffix = '*'.repeat(1024);
  const file = "$'";
  const targets = sedWriteTargets('gsed', ['-i' + suffix, 's/a/b/', file]);
  expect(targets[1].length).toBe(2048);
  expect(targets[1]).toBe(file.repeat(1024));
});

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

test('oversized backup-name expansion is rejected before execution', () => {
  const command = `sed -i'${'*'.repeat(1024)}' 's/a/b/' ${'n'.repeat(256)}`;
  const result = evaluate(command);
  expect(result.decision).toBe('denied');
  expect(result.reason).toMatch(/backup.*inspection limit/i);
});

test.each(
  [
    "sed -i 's/a/b/' /opt/data/app.conf",
    "sed -i.bak 's/a/b/' /opt/data/app.conf",
    "sed -Ei.bak 's/a/b/' /opt/data/app.conf",
    "sed -i '' 's/a/b/' /opt/data/app.conf",
    "sed -I.bak 's/a/b/' /opt/data/app.conf",
    "sed --in-place=.bak --expression='s/a/b/' /opt/data/app.conf",
    "gsed -i -e 's/a/b/' /opt/data/app.conf",
    'sed -i.bak -f ./script.sed /opt/data/app.conf',
    'sed -i.bak -f./script.sed /opt/data/app.conf',
    "env -u FEATURE sed -i.bak 's/a/b/' /opt/data/app.conf",
    "cd /opt/data && sed -i.bak 's/a/b/' app.conf",
    "sed -i.bak 's/a/b/' ../app.conf",
    'sed -i.bak \'s/a/b/\' /opt/data/app.conf "$OTHER"',
    "sed -i'/opt/backups/*' 's/a/b/' notes.txt",
    "sed --in-place='../*' 's/a/b/' notes.txt",
    "sed -i.bak -e 's/a/b/' -- /opt/data/app.conf",
    "sed -i.bak 's/a/b/' notes.txt -e /opt/data/app.conf",
  ].flatMap((command) => [
    command,
    `${command} > /tmp/edit.log 2>&1`,
    `${command} 2>/dev/null`,
  ]),
)('in-place edits and backups remain fenced: %s', (command) => {
  expect(evaluate(command)).toMatchObject({
    actionKey: 'bash:workspace-fence',
    writeIntent: true,
    decision: 'required',
  });
});

test.each([
  "sed -i.bak 's/a/b/' notes.txt",
  "sed -i '' 's/a/b/' notes.txt > /tmp/edit.log",
  "sed -i.bak '/^#/d' notes.txt > /tmp/edit.log",
  "gsed -i '/^#/d' notes.txt > /tmp/edit.log",
  'sed -i.bak -f /opt/scripts/update.sed notes.txt > /tmp/edit.log',
  'sed -i.bak --file=/opt/scripts/update.sed notes.txt > /tmp/edit.log',
  "sed -n '/pattern/p' /opt/data/notes.txt > /tmp/edit.log",
  "sed -e '-i /opt/data' notes.txt > /tmp/edit.log",
  "sed -i.bak -e 's/a/b/' -- ./--in-place=/opt/data > /tmp/edit.log",
  "sed -i.bak 's/a/b/' /tmp/notes.txt",
  "echo sed -i 's/a/b/' /opt/data > /tmp/edit.log",
  'echo -o .env.fixture > /tmp/edit.log',
  "printf '%s' -o .env.fixture > /tmp/edit.log",
])(
  'ordinary edits and script inputs retain their existing decisions: %s',
  (command) => {
    expect(evaluate(command).decision).toBe('approved_fullauto');
  },
);

test('ambiguous empty-suffix syntax retains the GNU file operand', () => {
  expect(
    evaluate("sed -i '' '/opt/data/notes.txt' notes.txt > /tmp/edit.log"),
  ).toMatchObject({ actionKey: 'bash:workspace-fence', decision: 'required' });
});

test.each([
  "sed -Ei'.env*' 's/a/b/' notes.txt > /tmp/edit.log",
  "sed -Ei'.hybridclaw/*' 's/a/b/' notes.txt > /tmp/edit.log",
  "find . -name notes.txt -exec sed -Ei'.env*' 's/a/b/' {} + > /tmp/edit.log",
  "printf '%s\\n' notes.txt | xargs sed -Ei'.env*' 's/a/b/' > /tmp/edit.log",
])('computed backup names retain protected-path approval: %s', (command) => {
  expect(evaluate(command)).toMatchObject({
    pinned: true,
    decision: 'required',
  });
});
