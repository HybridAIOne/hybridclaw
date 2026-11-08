import path from 'node:path';
import { expect, test } from 'vitest';
import { TrustedAgentApprovalRuntime } from '../container/src/approval-policy.js';
import { useTempDir } from './test-utils.js';

const temp = useTempDir('hc-tar-targets-');
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
    'tar -xzf bundle.tgz -C /opt/data',
    'tar --extract --file=bundle.tar --directory=/opt/data',
    'tar xCf /opt/data bundle.tar',
    'tar -xC/opt/data -f bundle.tar',
    'tar -xf bundle.tar -C ../outside',
    'tar -xf bundle.tar -C nested -C ../../outside',
    'tar -xf bundle.tar -C /opt/data first -C /tmp second',
    'cd /opt/data && tar -xf bundle.tar',
    'env -u FEATURE tar -xf bundle.tar -C /opt/data',
    'tar -xf bundle.tar -C /opt/data first -C "$OTHER" second',
    'tar -cf /opt/data/bundle.tar notes.txt',
    'tar cf /opt/data/bundle.tar notes.txt',
    'tar --create --file=/opt/data/bundle.tar notes.txt',
    'tar -rf /opt/data/bundle.tar notes.txt',
    'tar -uf /opt/data/bundle.tar notes.txt',
    'tar --delete -f /opt/data/bundle.tar notes.txt',
    'tar -Af /opt/data/bundle.tar addition.tar',
    'tar -cf ../bundle.tar notes.txt',
    'gtar -xf bundle.tar -C /opt/data',
    'bsdtar -xf bundle.tar -C /opt/data',
    "sh -c 'tar -xf bundle.tar -C /opt/data'",
    'tar -cf /opt/bundle.tar --files-from ./files.txt',
    'tar -H -cf /opt/data/bundle.tar notes.txt',
    'tar -s -xf bundle.tar -C /opt/data',
  ].flatMap((command) => [
    command,
    `${command} > /tmp/archive.log 2>&1`,
    `${command} 2>/dev/null`,
  ]),
)('archive writes remain fenced: %s', (command) => {
  expect(evaluate(command)).toMatchObject({
    actionKey: 'bash:workspace-fence',
    writeIntent: true,
    decision: 'required',
  });
});

test.each([
  'tar -xf /opt/data/bundle.tar -C ./out',
  'tar -xf /opt/data/bundle.tar -C ./out > /tmp/archive.log',
  'tar -xf bundle.tar -C /tmp/out',
  'tar -xf bundle.tar -C /opt/data -C /tmp/out',
  'tar -cf ./bundle.tar -C /opt/data notes.txt',
  'tar -czf ./bundle.tgz /opt/data/notes.txt',
  'tar cfz ./bundle.tgz /opt/data/notes.txt',
  'tar -cfz /opt/data/notes.txt',
  'tar xCf ./out /opt/data/bundle.tar',
  'tar -tf /opt/data/bundle.tar',
  'tar -xOf /opt/data/bundle.tar',
  'tar --extract --to-stdout --file=/opt/data/bundle.tar -C /opt/data',
  'tar -cf - /opt/data/notes.txt > /tmp/bundle.tar',
  'tar -xf bundle.tar --exclude "--directory=/opt/ignored" -C ./out',
  'tar -xf bundle.tar -- --directory=/opt/member-name',
  'tar -xf bundle.tar -o /opt/member-name',
  'tar -xf bundle.tar -C ./out --strip-components 1',
  'echo tar -xf bundle.tar -C /opt/data > /tmp/notes',
])(
  'archive sources and ordinary workspace operations remain allowed: %s',
  (command) => {
    expect(evaluate(command).decision).toBe('approved_fullauto');
  },
);

test.each([
  'tar -xf bundle.tar --files-from /opt/files.txt',
  'tar -xf bundle.tar --unknown-mode /opt/data',
  'tar -xf /opt/data/bundle.tar --transform s/a/b/',
  'tar -c /opt/data/notes.txt > archive.log',
])(
  'unparsed archive options retain the conservative path fallback: %s',
  (command) => {
    expect(evaluate(command)).toMatchObject({
      actionKey: 'bash:workspace-fence',
      decision: 'required',
    });
  },
);
