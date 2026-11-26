import { expect, test } from 'vitest';
import { guardCommand } from '../container/src/bash-safety.js';

test.each([
  'gcc -c sample.c -o eval.o',
  'cc -o sample helpers/eval.o main.o',
  '/usr/bin/clang++ "eval.o" -o sample',
  'cd src && cc -O2 -o app main.o eval.o',
])('treats a literal data operand as data in %s', (command) => {
  expect(guardCommand(command)).toBeNull();
});

test.each([
  'eval.o example',
  './eval.o example',
  'cc -c sample.c -o eval.o && builtin eval "$code"',
  'cc -c sample.c -o "$(eval "$code")"',
  'cc -fplugin=eval.o -c sample.c',
  'clang -Xclang -load -Xclang eval.o -c sample.c',
  './custom/cc -o sample eval.o',
  'xargs cc -o sample eval.o',
  'sh -c \'cc -o sample eval.o\'',
  'for unit in eval; do "$unit" "$code"; done',
  'for unit in main eval; do eval "$code"; done',
  'for unit in "$(eval "$code")"; do printf "%s" "$unit"; done',
  'for unit in main "$(printf eval)"; do "$unit" "$code"; done',
  'node -e "obj.eval.call(null, code)"',
])('keeps blocking shell execution and opaque operands in %s', (command) => {
  expect(guardCommand(command)).toContain('safety rule eval:');
});

test('keeps independent safety rules active', () => {
  expect(guardCommand('cc -o sample eval.o && rm -rf scratch')).toContain(
    'safety rule recursive-delete:',
  );
});
