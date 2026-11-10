import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.js';

const temporary = useTempDir('xml-reader-');
useCleanMocks({ unstubAllEnvs: true, resetModules: true });
let root: string;
let inspect: typeof import('../container/src/python-data-inspection.js').inspectPythonInline;
let scan: typeof import('../container/src/bash-remote-code.js').findFetchedCode;
let commands: typeof import('../container/src/bash-commands.js').scriptCommands;
let Runtime: typeof import('../container/src/approval-policy.js').TrustedAgentApprovalRuntime;
const reader = `import xml.etree.ElementTree as ET
ns={'a':'http://www.w3.org/2005/Atom'}
t=ET.parse('feed.xml')
for e in t.getroot().findall('a:entry',ns):
 title=e.find('a:title',ns).text.replace(chr(10),' ')
 print(title+'|'+e.find('a:published',ns).text[:10])`;
const command = (body: string) =>
  `python3 -c '${body.replaceAll("'", "'\\''")}'`;
beforeEach(async () => {
  root = temporary();
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', root);
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_DISPLAY_ROOT', '/workspace');
  vi.stubEnv('HYBRIDCLAW_AGENT_STATE_ROOT', root);
  inspect = (await import('../container/src/python-data-inspection.js'))
    .inspectPythonInline;
  scan = (await import('../container/src/bash-remote-code.js')).findFetchedCode;
  commands = (await import('../container/src/bash-commands.js')).scriptCommands;
  Runtime = (await import('../container/src/approval-policy.js'))
    .TrustedAgentApprovalRuntime;
});
function runtime() {
  const r = new Runtime(path.join(root, 'policy.yaml'));
  r.setSession('xml-session');
  r.setApprovalMode({ mode: 'full' });
  return r;
}
function evaluate(r: InstanceType<typeof Runtime>, text: string) {
  return r.evaluateToolCall({
    toolName: 'bash',
    argsJson: JSON.stringify({ command: text }),
    latestUserPrompt: 'Read the feed and list entry titles.',
  });
}

test.each([
  'import xml.etree.ElementTree as ET',
  'from xml.etree import ElementTree as ET',
  'import xml.etree.ElementTree',
])('recognizes bounded XML reads with %s', (declaration) => {
  const body = reader
    .replace('import xml.etree.ElementTree as ET', declaration)
    .replaceAll(
      'ET.parse',
      declaration === 'import xml.etree.ElementTree'
        ? 'xml.etree.ElementTree.parse'
        : 'ET.parse',
    );
  expect(inspect(body, ['feed.xml'])?.data).toMatchObject({
    reads: ['feed.xml'],
    writes: [],
  });
  expect(scan(commands(command(body)), new Set(['feed.xml'])).runs).toBe(false);
});
test('a scratch-directory XML read keeps its actual paths and policy checks', () => {
  const scratch = temporary();
  const r = runtime();
  const download = `cd ${scratch} && curl -o feed.xml https://example.com/feed`;
  r.afterToolExecution(evaluate(r, download), true);
  const action = evaluate(r, `cd ${scratch} && ${command(reader)}`);
  expect(action.decision).toBe('approved_fullauto');
  expect(
    scan(
      commands(`cd ${scratch} && ${command(reader)}`),
      new Set([path.join(scratch, 'feed.xml')]),
    ).pathHints,
  ).toContain(path.join(scratch, 'feed.xml'));
});
test.each([
  `ET.parse('feed.xml',parser=ET.XMLParser())`,
  `ET.parse('feed.xml').write('other.xml')`,
  `ET.parse('feed.xml').getroot().set('title','changed')`,
  `ET.parse('feed.xml').getroot().text= 'changed'`,
  `exec(ET.parse('feed.xml').getroot().text)`,
  `eval(ET.parse('feed.xml').getroot().text)`,
  `ET.parse=lambda p: exec(p); ET.parse('feed.xml')`,
  `ET=__import__('os'); ET.parse('feed.xml')`,
  `getattr(ET,'parse')('feed.xml')`,
  `filename='feed.xml'; ET.parse(filename)`,
])('does not certify unsupported XML syntax: %s', (tail) => {
  const text = 'import xml.etree.ElementTree as ET; ' + tail;
  expect(inspect(text, ['feed.xml'])?.data).toBeNull();
  expect(scan(commands(command(text)), new Set(['feed.xml']))).toMatchObject({
    runs: true,
    uncertain: true,
  });
});
test.each([
  'xml.py',
  'xml/__init__.py',
  'xml/etree.py',
  'xml/etree/ElementTree.py',
  '\0unknown-fetch-location',
])('fetched startup code or unknown destinations remain unsafe: %s', (file) => {
  expect(
    scan(commands(command(reader)), new Set(['feed.xml', file])),
  ).toMatchObject({ runs: true, uncertain: true });
});
test('an imported parent module can shadow a descendant import', () => {
  expect(
    scan(
      commands(command('import xml.etree.ElementTree')),
      new Set(['xml/etree.py']),
    ),
  ).toMatchObject({ runs: true, uncertain: true });
});
test.each(['.env.fixture', '/etc/private.xml', 'private/feed.xml'])(
  'read-only XML does not bypass pinned paths: %s',
  (file) => {
    fs.writeFileSync(
      path.join(root, 'policy.yaml'),
      'approval:\n  pinned_red:\n    - paths: ["private/**"]\n',
    );
    expect(
      evaluate(
        runtime(),
        command(reader.replace("'feed.xml'", JSON.stringify(file))),
      ),
    ).toMatchObject({ decision: 'required', pinned: true });
  },
);
test('a canonical XML input cannot hide a pinned symlink target', () => {
  fs.writeFileSync(path.join(root, '.env.fixture'), '<feed/>');
  fs.symlinkSync('.env.fixture', path.join(root, 'feed.xml'));
  expect(evaluate(runtime(), command(reader))).toMatchObject({
    decision: 'required',
    pinned: true,
  });
});
test.each(['sh output.txt', 'python3 output.txt'])(
  'derived XML output remains fetched code: %s',
  (execute) => {
    const r = runtime();
    evaluate(r, 'curl -o feed.xml https://example.com/feed');
    const extract = command(reader) + ' > output.txt';
    expect(evaluate(r, extract).decision).toBe('approved_fullauto');
    const next = runtime();
    expect(evaluate(next, execute)).toMatchObject({
      decision: 'required',
      actionKey: 'bash:fetched-code',
    });
  },
);
test('piped XML output remains fetched code', () => {
  expect(
    scan(commands(command(reader) + ' | sh'), new Set(['feed.xml'])),
  ).toMatchObject({ runs: true });
});

test.each(['tee output.txt', 'cat > output.txt'])(
  'a pipeline %s preserves extracted provenance',
  (consumer) => {
    const r = runtime();
    evaluate(r, 'curl -o feed.xml https://example.com/feed');
    expect(evaluate(r, command(reader) + ' | ' + consumer).decision).toBe(
      'approved_fullauto',
    );
    expect(evaluate(runtime(), 'python3 output.txt')).toMatchObject({
      decision: 'required',
      actionKey: 'bash:fetched-code',
    });
  },
);
test.each(['/opt/summary.txt', '.env.summary'])(
  'XML output retains write boundaries: %s',
  (target) => {
    const r = runtime();
    evaluate(r, 'curl -o feed.xml https://example.com/feed');
    expect(evaluate(r, command(reader) + ' > ' + target)).toMatchObject({
      decision: 'required',
      ...(target.startsWith('/opt')
        ? { actionKey: 'bash:workspace-fence' }
        : { pinned: true }),
    });
  },
);
