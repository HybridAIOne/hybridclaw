import { afterEach, expect, test } from 'vitest';
import { guardCommand } from '../container/src/bash-safety.js';
import { configureSafetyRules } from '../container/src/safety-rules.js';

afterEach(() => configureSafetyRules(undefined));

test.each([
  '/opt/envs/eval/bin/python --version',
  '/opt/envs/eval/bin/pip list',
  'ls /opt/envs/eval/bin/python*',
  'ls ./envs/eval/bin/',
  'env LANG=C /opt/envs/eval/bin/python --version',
])(
  'does not mistake a literal directory component for eval execution: %s',
  (command) => {
    expect(guardCommand(command)).toBeNull();
  },
);

test.each([
  'eval "$COMMAND"',
  'builtin eval "$COMMAND"',
  'ev\\al "$COMMAND"',
  "'eval' 'echo example'",
  'echo $(eval "$COMMAND")',
  'echo `eval "$COMMAND"`',
  'sh -c \'eval "$COMMAND"\'',
  'sh -c \'ev\\al "$COMMAND"\'',
  'xargs sh -c \'ev\\al "$COMMAND"\'',
  'find . -exec sh -c \'ev\\al "$COMMAND"\' \\;',
  'e"v"al "$COMMAND"',
  'node -e \'eval/*comment*/("code")\'',
  'node -e \'/*comment*/eval/*comment*/("code")\'',
  '/opt/bin/eval example',
  '/opt/envs/eval/bin/python -c \'eval("code")\'',
  'node <<\'EOF\'\n/*comment*/eval/*comment*/("code")\nEOF',
  'node <<<\'/*comment*/eval/*comment*/("code")\'',
])('retains the eval hard block for execution: %s', (command) => {
  expect(guardCommand(command)).toContain('safety rule eval');
});

test('path normalization does not disable other hard blocks', () => {
  expect(
    guardCommand('/opt/envs/eval/bin/python --version && rm -rf scratch'),
  ).toContain('recursive-delete');
});
