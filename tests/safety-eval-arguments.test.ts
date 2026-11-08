import { afterEach, expect, test } from 'vitest';
import { guardCommand } from '../container/src/bash-safety.js';
import { configureSafetyRules } from '../container/src/safety-rules.js';

afterEach(() => configureSafetyRules(undefined));

test.each([
  'conda activate eval',
  'conda activate "eval"',
  'conda activate model-eval',
  'conda activate /opt/envs/eval',
  'conda activate ~/envs/eval',
  'env -u FEATURE conda activate eval',
  'cd /tmp && conda activate eval && python --version',
])('an environment operand is not eval execution: %s', (command) => {
  expect(guardCommand(command)).toBeNull();
});

test.each([
  'eval "printf marker"',
  'conda activate example && eval "printf marker"',
  'conda activate "$(eval printf marker)"',
  'conda activate `eval printf marker`',
  'env -u FEATURE bash -c \'eval "printf marker"\'',
  'ssh example.com conda activate eval',
  'docker exec example bash -c \'eval "printf marker"\'',
  'env -S "conda activate eval"',
  'conda run -n example bash -c \'eval "printf marker"\'',
  'conda shell.bash activate eval',
  'conda activate --eval',
  'conda activate eval extra',
  '$(printf eval) "printf marker"',
])('execution and unknown argument roles stay blocked: %s', (command) => {
  expect(guardCommand(command)).toContain('safety rule eval:');
});

test('activation never suppresses an independently matching source rule', () => {
  const result = guardCommand(
    'source /opt/miniconda/etc/profile.d/conda.sh && conda activate eval',
  );
  expect(result).toContain('safety rule source-script:');
  expect(result).not.toContain('safety rule eval:');
});

test('explicitly disabling eval still leaves source-script blocking active', () => {
  configureSafetyRules(['eval']);
  expect(guardCommand('eval "printf marker"')).toBeNull();
  expect(guardCommand('source setup.sh && conda activate eval')).toContain(
    'safety rule source-script:',
  );
});
