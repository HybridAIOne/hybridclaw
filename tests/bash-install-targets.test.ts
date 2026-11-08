import path from 'node:path';
import { expect, test } from 'vitest';
import { TrustedAgentApprovalRuntime } from '../container/src/approval-policy.js';
import { useTempDir } from './test-utils.js';

const temp = useTempDir('hc-install-targets-');
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
    'pip install --target /opt/libs sample-package',
    'pip install --target=/opt/libs sample-package',
    'pip3 install -t /opt/libs sample-package',
    'pip3.12 install -t/opt/libs sample-package',
    'pip install -qt/opt/libs sample-package',
    'python3 -m pip install --target /opt/libs sample-package',
    '/usr/bin/python3 -m pip install --target=/opt/libs sample-package',
    'env -u FEATURE python3 -m pip install -t /opt/libs sample-package',
    'cd /opt && pip install --target libs sample-package',
    'pip install --target ../libs sample-package',
    'pip install --target /opt/libs --target "$OTHER" sample-package',
  ].flatMap((command) => [
    `${command} > /tmp/install.log 2>&1`,
    `${command} 2>/dev/null`,
  ]),
)(
  'explicit install targets remain fenced beside discarded output: %s',
  (command) => {
    expect(evaluate(command)).toMatchObject({
      actionKey: 'bash:workspace-fence',
      writeIntent: true,
      decision: 'required',
    });
  },
);

test.each([
  'pip install --target ./vendor /opt/wheels/sample.whl > /tmp/install.log',
  'python3 -m pip install -t ./vendor -r /opt/requirements.txt > /tmp/install.log',
  'pip install --target /tmp/vendor sample-package > /tmp/install.log',
  'pip install --requirement "--target=/opt/not-a-destination" --target ./vendor > /tmp/install.log',
  'pip install -qr--target=/opt/not-a-destination --target ./vendor > /tmp/install.log',
  'pip install --target ./vendor -- ./--target=/opt/notes > /tmp/install.log',
  'python3 -c "print(1)" -m pip --target /opt/data > /tmp/install.log',
  'echo pip install --target /opt/data > /tmp/install.log',
])(
  'installer inputs and ordinary workspace installs retain capability: %s',
  (command) => {
    expect(evaluate(command).actionKey).not.toBe('bash:workspace-fence');
  },
);
