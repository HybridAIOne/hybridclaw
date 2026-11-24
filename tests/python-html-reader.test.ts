import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.js';

const temporary = useTempDir('html-reader-');
useCleanMocks({ unstubAllEnvs: true, resetModules: true });
let root: string;
let inspect: typeof import('../container/src/python-data-inspection.js').inspectPythonInline;
let Runtime: typeof import('../container/src/approval-policy.js').TrustedAgentApprovalRuntime;
let stdinCommands: typeof import('../container/src/python-stdin-inspection.js').quotedPythonStdinCommands;

const reader = `from bs4 import BeautifulSoup
soup = BeautifulSoup(open('page.html', encoding='utf-8'), 'html.parser')
section = soup.find(id='page-content')
block = section.find(class_='collapsible-block')
print(str(block)[:1500])
content = block.find(class_='collapsible-block-content')
if content:
    print(content.get_text()[:200])`;
const command = (body: string) =>
  `python3 -c '${body.replaceAll("'", "'\\''")}'`;

beforeEach(async () => {
  root = temporary();
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', root);
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_DISPLAY_ROOT', '/workspace');
  vi.stubEnv('HYBRIDCLAW_AGENT_STATE_ROOT', root);
  inspect = (await import('../container/src/python-data-inspection.js')).inspectPythonInline;
  Runtime = (await import('../container/src/approval-policy.js')).TrustedAgentApprovalRuntime;
  stdinCommands = (await import('../container/src/python-stdin-inspection.js')).quotedPythonStdinCommands;
});

function runtime() {
  const value = new Runtime(path.join(root, 'policy.yaml'));
  value.setSession('html-session');
  value.setApprovalMode({ mode: 'full' });
  return value;
}

function evaluate(value: InstanceType<typeof Runtime>, text: string) {
  return value.evaluateToolCall({
    toolName: 'bash',
    argsJson: JSON.stringify({ command: text }),
    latestUserPrompt: 'Inspect downloaded documents.',
  });
}

test('recognizes literal HTML reads and read-only tree inspection', () => {
  expect(inspect(reader, ['page.html'])?.data).toMatchObject({
    reads: ['page.html'], writes: [],
  });
});

test('scratch HTML inspection keeps provenance across worker replacement', () => {
  const scratch = temporary();
  const value = runtime();
  const download = `cd ${scratch} && curl -o page.html https://example.com/page`;
  value.afterToolExecution(evaluate(value, download), true);
  const read = evaluate(runtime(), `cd ${scratch} && ${command(reader)}`);
  expect(read.decision).toBe('approved_fullauto');
  expect(inspect(reader, [path.join(scratch, 'page.html')], scratch)?.data?.pathHints)
    .toContain(path.join(scratch, 'page.html'));
  expect(evaluate(runtime(), `python3 ${scratch}/page.html`)).toMatchObject({
    actionKey: 'bash:fetched-code', decision: 'required',
  });
});

test.each([
  "exec(content.get_text())",
  "eval(content.get_text())",
  "soup.find(string=eval)",
  "soup.append('changed')",
  "soup.__class__",
  "getattr(soup, 'find')('div')",
  "soup.find = print",
])('unsupported execution or mutation remains opaque: %s', (tail) => {
  expect(inspect(reader + '\n' + tail, ['page.html'])?.data).toBeNull();
});

test.each(['xml', 'lxml-xml', 'custom-builder'])(
  'does not certify an alternate HTML builder: %s', (builder) => {
    expect(inspect(reader.replace("'html.parser'", JSON.stringify(builder)), ['page.html'])?.data).toBeNull();
  },
);

test.each(['html.parser', 'lxml', 'html5lib'])(
  'recognizes installed HTML builders and read-only formatting: %s', (builder) => {
    const body = `from bs4 import BeautifulSoup
with open('page.html') as file:
    html = file.read()
soup = BeautifulSoup(html, '${builder}')
content = soup.find('div', id='page-content')
if content:
    print(content.prettify()[:8000])
else:
    for div in soup.find_all('div', class_=True):
        if 'content' in ' '.join(div.get('class', [])):
            print(div.get('class'))`;
    expect(inspect(body, ['page.html'])?.data).toMatchObject({ reads: ['page.html'], writes: [] });
  },
);

test('formatted HTML output retains fetched origins before execution', () => {
  const value = runtime();
  value.afterToolExecution(evaluate(value, 'curl https://example.com/page -o page.html'), true);
  const formatted = command(reader.replace('content.get_text()', 'content.prettify()')) + ' > rendered.py';
  const decision = evaluate(value, formatted);
  expect(decision.decision).toBe('approved_fullauto');
  value.afterToolExecution(decision, true);
  expect(evaluate(runtime(), 'python3 rendered.py')).toMatchObject({
    actionKey: 'bash:fetched-code', decision: 'required',
  });
});

test.each(['re', 'regex'])(
  'recognizes read-only HTML text matching with %s', (alias) => {
    const body = reader + `
import re as ${alias}
text = content.get_text()
match = ${alias}.search('Object Class', text, ${alias}.IGNORECASE)
print(match)
if match:
    print(match.group(0), match.span())
print(${alias}.findall('Class', text))
print(${alias}.sub('Class', 'Type', text))`;
    expect(inspect(body, ['page.html'])?.data?.reads).toContain('page.html');
    expect(inspect(body, ['page.html', 're.py'])?.data).toBeNull();
    expect(inspect(body, ['\0unknown-fetch-location'])?.data).toBeNull();
  },
);

test.each([
  "re.sub('x', eval, content.get_text())",
  "re.sub('x', lambda value: exec(value.group()), content.get_text())",
  "re.__dict__",
  "match.__class__",
])('regex callbacks and reflection stay opaque: %s', (tail) => {
  const body = reader + "\nimport re\nmatch = re.search('x', content.get_text())\n" + tail;
  expect(inspect(body, ['page.html'])?.data).toBeNull();
});

test.each(['bs4.py', 'bs4/__init__.py', 'bs4/element.py', 'sitecustomize.py', '\0unknown-fetch-location'])(
  'downloaded startup code cannot gain a data-only exemption: %s', (file) => {
    expect(inspect(reader, ['page.html', file])?.data).toBeNull();
  },
);

test('literal and canonical read paths still require pinned approval', () => {
  fs.writeFileSync(path.join(root, '.env.fixture'), '<p>private</p>');
  fs.symlinkSync('.env.fixture', path.join(root, 'page.html'));
  expect(evaluate(runtime(), command(reader))).toMatchObject({
    decision: 'required', pinned: true,
  });
});

test.each([
  ['from bs4 import BeautifulSoup as Soup', 'Soup'],
  ['import bs4 as html', 'html.BeautifulSoup'],
])('recognizes trusted parser aliases: %s', (declaration, parser) => {
  const body = reader.replace('from bs4 import BeautifulSoup', declaration)
    .replace('soup = BeautifulSoup', `soup = ${parser}`);
  expect(inspect(body, ['page.html'])?.data?.reads).toContain('page.html');
});

test('a fetched alias to importable code retains startup protection', () => {
  fs.writeFileSync(path.join(root, 'bs4.py'), '');
  fs.symlinkSync('bs4.py', path.join(root, 'page.html'));
  expect(inspect(reader, ['page.html'])?.data).toBeNull();
});

function unknownDownload(value: InstanceType<typeof Runtime>) {
  evaluate(value, 'for n in one two; do curl -o "page-$n.html" https://example.com/page; done');
}
const plain = "text = open('page.html', encoding='utf-8').read()\nprint(text[:100])";
const stdin = (source: string, delimiter = "'PY'") =>
  `python3 - <<${delimiter}\n${source}\nPY`;

test('quoted stdin permits verified no-import reads after an unknown download', () => {
  const value = runtime();
  unknownDownload(value);
  expect(evaluate(value, stdin(plain)).decision).toBe('approved_fullauto');
  expect(evaluate(value, stdin(plain.replace('page.html', '.env.fixture'))))
    .toMatchObject({ decision: 'required', pinned: true });
});

test.each([
  "exec(open('page.html').read())",
  "eval(open('page.html').read())",
  "import os; print(open('page.html').read())",
  "name='page.html'; print(open(name).read())",
])('unknown provenance retains approval for uncertified stdin: %s', (body) => {
  const value = runtime();
  unknownDownload(value);
  expect(evaluate(value, stdin(body))).toMatchObject({
    decision: 'required', actionKey: 'bash:fetched-code',
  });
});

test('HTML stdin retains later execution and redirection checks', () => {
  const value = runtime();
  value.afterToolExecution(evaluate(value, 'curl -o page.html https://example.com/page'), true);
  expect(evaluate(value, stdin(reader)).decision).toBe('approved_fullauto');
  expect(evaluate(value, stdin(reader) + '\npython3 page.html')).toMatchObject({
    decision: 'required', actionKey: 'bash:fetched-code',
  });
  expect(evaluate(value, stdin(reader) + '\ntouch /etc/blocked.html')).toMatchObject({
    decision: 'required', pinned: true,
  });
});

test.each([
  'python3 - <<PY\nprint(1)\nPY',
  "env PYTHONINSPECT=1 python3 <<'PY'\nprint(1)\nPY",
  "python3 <<'PY'\nprint(1)\n PY",
  "python3 <<'PY'\nprint(1)\nPY\ncat <<'OTHER'\nhi\nOTHER",
  "python3 <<'PY'\n" + '#'.repeat(32_769) + '\nPY',
])('expanded or unsupported stdin remains opaque: %s', (text) => {
  expect(stdinCommands(text)).toBeNull();
});
