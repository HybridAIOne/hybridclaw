import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from 'vitest';

import { TrustedAgentApprovalRuntime } from '../container/src/approval-policy.js';
import { useTempDir } from './test-utils.js';

const makeTempDir = useTempDir('hybridclaw-http-method-policy-');

function evaluate(command: string) {
  const root = makeTempDir();
  const policyPath = path.join(root, 'policy.yaml');
  fs.writeFileSync(
    policyPath,
    JSON.stringify({
      network: {
        default: 'deny',
        rules: [
          {
            action: 'allow',
            host: 'example.com',
            port: 443,
            methods: ['POST'],
            paths: ['/api/items'],
          },
          { action: 'deny', host: '*', port: '*', methods: ['*'], paths: ['/**'] },
        ],
      },
    }),
  );
  const runtime = new TrustedAgentApprovalRuntime(
    policyPath,
    path.join(root, 'agent-trust.json'),
    path.join(root, 'workspace-trust.json'),
    path.join(root, 'legacy-trust.json'),
    undefined,
    path.join(root, 'pending.json'),
  );
  runtime.setApprovalMode({ mode: 'full' });
  return runtime.evaluateToolCall({
    toolName: 'bash',
    argsJson: JSON.stringify({ command }),
    latestUserPrompt: 'Call the approved API.',
  });
}

test.each([
  '-X POST',
  '--request POST',
  '-d "{}"',
  '--data "{}"',
  '--data-raw "{}"',
  '--data-binary "{}"',
  '--data={}',
  '-F item=value',
  '--form item=value',
])('allows the configured POST through curl %s', (flags) => {
  expect(evaluate(`curl -s ${flags} https://example.com/api/items`)).toMatchObject({
    tier: 'green',
    decision: 'auto',
  });
});

test.each([
  'curl -s https://example.com/api/items',
  'curl -s -f https://example.com/api/items',
  'curl -s -x POST https://example.com/api/items',
  'curl -s -X GET https://example.com/api/items',
  'curl -s -X DELETE https://example.com/api/items',
  'curl -s --request PATCH https://example.com/api/items',
  'curl -s -X POST https://example.com/api/other',
])('preserves explicit network denials under full-auto: %s', (command) => {
  expect(evaluate(command)).toMatchObject({
    tier: 'red',
    decision: 'denied',
  });
});

test('recognizes the method in the observed multi-request command shape', () => {
  const request =
    'curl -s -m 3 -X POST https://example.com/api/items -H "Content-Type: application/json" -d "{}"';
  expect(evaluate(`${request}; echo done; ${request}`)).toMatchObject({
    tier: 'green',
    decision: 'auto',
  });
});
