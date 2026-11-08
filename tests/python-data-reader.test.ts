import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { inspectPythonInline } from '../container/src/python-data-inspection.js';
import { useCleanMocks, useTempDir } from './test-utils.js';

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  spawn.mockImplementation(actual.spawnSync);
  return { ...actual, spawnSync: spawn };
});
useCleanMocks({
  cleanup: () => {
    spawn.mockClear();
  },
});
const temporary = useTempDir('python-data-reader-');
const saved = ['/tmp/records.data'];
const inspectPythonData = (source: string, files: Iterable<string>) => inspectPythonInline(source, files)?.data ?? null;

test.each([
  "import json; print(json.load(open('/tmp/records.data')))",
  "import json as j; d=j.load(open('/tmp/records.data')); print(d.get('title'))",
  "import json\nd=json.load(open('/tmp/records.data'))\nfor row in d.get('items',[]):\n print(row.get('title'), row.get('url'))",
  "import json\nwith open('/tmp/records.data', encoding='utf8') as stream:\n data=json.load(stream)\nprint(data)",
  'import json,sys; print(json.load(sys.stdin))',
  'import sys; print(sys.stdin.read())',
  "import json; print(json.loads(open('/tmp/records.data').read()))",
  "import json; d=json.load(open('/tmp/records.data', 'rb')); print(len(d), json.dumps(d))",
  "data=['A','B']; print(','.join(data).lower(), data[0:1])",
  "data={'a': 1}\nfor key, value in data.items():\n print(f'{key}: {value + 1}')",
  'x=3\nif x>2:\n print(str(x))\nelse:\n print(0)',
])('recognizes data-only syntax without reading the input: %s', (source) => {
  expect(inspectPythonData(source, saved)).not.toBeNull();
});

test.each([
  "exec(open('/tmp/records.data').read())",
  "eval(open('/tmp/records.data').read())",
  "import json; json.loads(open('/tmp/records.data').read(), object_hook=exec)",
  "import json; json.load = eval; print(json.load(open('/tmp/records.data')))",
  "import json; open=eval; print(json.load(open('/tmp/records.data')))",
  "import json as print; print('malformed')",
  "import os; os.system('echo unexpected')",
  "import json; print(getattr(json, 'loads')('{}'))",
  "import json; print(__import__('os'))",
  'data={}; print(data.__class__)',
  'data=[]; print(data[0]())',
  "import json; print(json.load(open('/tmp/records.data', 'w')))",
  "import json; print(json.load(open('/tmp/records.data', mode='r+')))",
  "import json; print(json.load(open('/tmp/records.data', opener=handler)))",
  "print('data', file=open('/tmp/records.data', 'w'))",
  "import sys; sys.path.append('/tmp')",
  "from pathlib import Path; print(Path('/tmp/records.data').read_text())",
  "import json; print(json.load(open('/tmp/records.data'))",
  "def run():\n return eval('1')\nrun()",
  'class Item:\n pass',
  "import json; globals()['json']=None",
])('keeps unsupported or executable syntax conservative: %s', (source) => {
  expect(inspectPythonData(source, saved)).toBeNull();
});

test.each([
  '/tmp/json.py',
  '/tmp/json/__init__.py',
  '/tmp/imports.zip',
  '\0unknown-fetch-location',
])(
  'downloaded code or unknown provenance prevents a data-only exemption: %s',
  (file) => {
    expect(
      inspectPythonData(
        "import json; print(json.load(open('/tmp/records.data')))",
        [file, ...saved],
      ),
    ).toBeNull();
    expect(spawn).not.toHaveBeenCalled();
  },
);

test('parsing never executes the supplied program', () => {
  const marker = path.join(temporary(), 'unexpected');
  expect(
    inspectPythonData(
      `open(${JSON.stringify(marker)}, 'w').write('executed')`,
      [],
    ),
  ).toBeNull();
  expect(fs.existsSync(marker)).toBe(false);
});

test('bounds parser input before creating a process', () => {
  expect(inspectPythonData('#'.repeat(32769), [])).toBeNull();
  expect(spawn).not.toHaveBeenCalled();
});

test('bounds AST size inside the parser', () => {
  expect(inspectPythonData('1\n'.repeat(2500), [])).toBeNull();
});

test.each([
  { status: null, error: new Error('ENOENT'), stdout: '' },
  { status: null, error: new Error('ETIMEDOUT'), stdout: '' },
  { status: 1, stdout: '' },
  { status: 0, stdout: 'malformed' },
  { status: 0, stdout: null },
])('a failed or malformed parser response is not permission: %j', (result) => {
  spawn.mockReturnValueOnce(result);
  expect(inspectPythonData("print('data')", [])).toBeNull();
});

test('the input limit counts UTF-8 bytes', () => {
  expect(inspectPythonData('#' + 'é'.repeat(16384), [])).toBeNull();
  expect(spawn).not.toHaveBeenCalled();
});
