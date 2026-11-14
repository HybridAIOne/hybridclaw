import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { TrustedAgentApprovalRuntime } from '../container/src/approval-policy.js';
import { useTempDir } from './test-utils.js';

const temp = useTempDir('hc-literal-patterns-');

function evaluate(command: string) {
  return new TrustedAgentApprovalRuntime(path.join(temp(), 'missing.yaml'))
    .evaluateToolCall({ toolName: 'bash', argsJson: JSON.stringify({ command }) });
}

test.each([
  "grep -oE '<a[^>]*>[^<]*' page.html",
  "grep -e '<[^>]*>' page.html",
  "grep --regexp='<[^>]*>' page.html",
  "grep '>' page.html",
  "sed 's/<[^>]*>//' page.html",
  "sed 's/.*class=\"snippet\"[^>]*>//' page.html",
  "sed -n -e 's/<[^>]*>//gp' page.html",
  "sed -E 's#.*class=[^>]*>##g' page.html",
  "grep -oE '<a[^>]*>[^<]*' page.html | sed 's/<[^>]*>//' | head -8",
  "F=page.html; grep -oE '<a[^>]*>[^<]*' \"$F\" | sed 's/<[^>]*>//' | head -8; echo 'snippets'; grep -oE 'class=\"snippet\"[^>]*>.{0,80}' \"$F\" | sed 's/.*class=\"snippet\"[^>]*>//' | head -6",
])('literal patterns are data rather than shell writes or pinned globs: %s', (command) => {
  expect(evaluate(command)).toMatchObject({ writeIntent: false, pinned: false });
});

test.each([
  "grep -oE '<a[^>]*>' page.html > /opt/data/out.txt",
  "sed 's/<[^>]*>//' page.html > /opt/data/out.txt",
  "grep \"$(printf x > /opt/data/out.txt)\" page.html",
  "sed -i.bak 's/<[^>]*>//' /opt/data/page.html",
])('actual writes retain the workspace fence: %s', (command) => {
  expect(evaluate(command)).toMatchObject({
    actionKey: 'bash:workspace-fence', writeIntent: true, decision: 'required',
  });
});

test.each([
  "grep -oE '<a[^>]*>' .env",
  "grep '>' .env",
  "grep '2>' .env",
  "grep --regexp '<a[^>]*>' .env",
  "sed 's/<[^>]*>//' .env",
  "grep -oE '<a[^>]*>' page.html | cat .env",
  "sed 's/<[^>]*>//' page.html; cat /etc/shadow",
  "sed -n -f .env page.html",
])('real sensitive operands remain pinned: %s', (command) => {
  expect(evaluate(command)).toMatchObject({ pinned: true, decision: 'required' });
});

test.each([
  "awk '{ print > \"/opt/data/out.txt\" }' page.html",
  "sed 's/a>b/x/e' page.html",
  "sed -e 's/a>b/x/' -e 'w /opt/data/out.txt' page.html",
])('opaque programs and mutating sed expressions keep conservative write detection: %s', (command) => {
  expect(evaluate(command).writeIntent).toBe(true);
});

test('an explicit path pin still applies to the input file', () => {
  const policy = path.join(temp(), 'policy.yaml');
  fs.writeFileSync(policy, 'approval:\n  pinned_red:\n    - paths: [page.html]\n');
  const result = new TrustedAgentApprovalRuntime(policy).evaluateToolCall({
    toolName: 'bash',
    argsJson: JSON.stringify({ command: "grep '<tag>' page.html | sed 's/<[^>]*>//'" }),
  });
  expect(result).toMatchObject({ pinned: true, decision: 'required' });
});
