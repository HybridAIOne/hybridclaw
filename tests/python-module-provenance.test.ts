import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.js';

const temporary = useTempDir('python-module-provenance-');
useCleanMocks({ unstubAllEnvs: true, resetModules: true });
let root: string;
let scan: typeof import('../container/src/bash-remote-code.js').findFetchedCode;
let commands: typeof import('../container/src/bash-commands.js').scriptCommands;
let Runtime: typeof import('../container/src/approval-policy.js').TrustedAgentApprovalRuntime;

beforeEach(async () => {
  root = temporary();
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', root);
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_DISPLAY_ROOT', '/workspace');
  vi.stubEnv('HYBRIDCLAW_AGENT_STATE_ROOT', root);
  vi.resetModules();
  scan = (await import('../container/src/bash-remote-code.js')).findFetchedCode;
  commands = (await import('../container/src/bash-commands.js')).scriptCommands;
  Runtime = (await import('../container/src/approval-policy.js')).TrustedAgentApprovalRuntime;
});

function analyze(command: string, files = ['json.py']) {
  return scan(commands(command), new Set(files));
}

test.each([
  `python3 -c 'import json; print(json.dumps({}))'`,
  `python3 -S -c 'import json'`,
  `python3 -E -c 'import json'`,
  `python3 -Bc 'import json'`,
  `python3 -c 'import json' --version`,
  `python3 -c 'import json' -I`,
  'python3 -m json',
  'python3 -Bmq package',
  'python3 local.py',
  'python3 -- local.py',
  'python3 -',
  'python3 < safe/program.txt',
  `python3 -W I -c 'import json'`,
  `python3 -X I -c 'import json'`,
  `python3 -cimport\\ json`,
])('reviews Python when fetched modules are visible at startup: %s', command => {
  expect(analyze(command)).toMatchObject({runs: true, uncertain: true});
});

test.each([
  'python3 --version',
  'python3 --help',
  'python3 -VV',
  'python3 -IV',
  `python3 -I -c 'import json; print(json.dumps({}))'`,
  `python3 -Ic 'import json'`,
  `python3 -BIc 'import json'`,
  'python3 -I local.py',
  'python3 safe/local.py',
  `cd safe && python3 -c 'import json'`,
])('preserves non-executing and excluded import-root controls: %s', command => {
  expect(analyze(command).runs).toBe(false);
});

test('an unrelated download directory cannot shadow a top-level import', () => {
  expect(analyze(`python3 -c 'import json'`, ['downloads/json.py']).runs).toBe(false);
  expect(analyze(`python3 -c 'import downloads.json'`, ['downloads/json.py']).runs).toBe(true);
  expect(analyze(`python3 -c 'from downloads import json'`, ['downloads/json.py']).runs).toBe(true);
});

test.each(['json.pyc', 'json.abi3.so', 'json.pyd', 'json/__init__.py'])(
  'reviews other importable forms: %s', file => {
    expect(analyze(`python3 -c 'import json'`, [file]).runs).toBe(true);
  },
);

test.each([
  `import sys; sys.path.insert(0, '.'); import json`,
  `import sys as system; system.path.append('.'); import json`,
  `from sys import path as locations; locations.append('.'); import json`,
  `getattr(__import__('sys'), 'path').append('.'); import json`,
  `import importlib; importlib.import_module('sys').path.append('.'); import json`,
])('isolation cannot exempt explicit import-path changes: %s', source => {
  expect(analyze(`python3 -I -c "${source}"`).runs).toBe(true);
});

test('isolated mode does not authorize executing a fetched file', () => {
  expect(analyze('python3 -I json.py').runs).toBe(true);
  expect(analyze('python3 -- --version', ['--version']).runs).toBe(true);
});

test('uses the script directory rather than cwd for direct scripts', () => {
  expect(analyze('python3 safe/local.py', ['safe/json.py']).runs).toBe(true);
  expect(analyze('cd safe && python3 ../local.py', ['json.py']).runs).toBe(true);
});

test('display aliases and actual paths refer to the same import root', () => {
  expect(analyze(`cd /workspace && python3 -c 'import json'`, [path.join(root, 'json.py')]).runs).toBe(true);
});

test('a replacement worker retains downloaded-module review', () => {
  const makeRuntime = () => {
    const r = new Runtime(...['policy.yaml', 'agent.json', 'all.json', 'legacy.json'].map(n => path.join(root, n)) as [string, string, string, string], undefined, path.join(root, 'pending.json'));
    r.setApprovalMode({mode: 'full'});
    r.setSession('module-origin');
    return r;
  };
  const evaluate = (r: InstanceType<typeof Runtime>, command: string) => r.evaluateToolCall({toolName:'bash', argsJson:JSON.stringify({command}), latestUserPrompt:'Process the fixture data.'});
  evaluate(makeRuntime(), 'curl -o json.py https://example.com/module.py');
  fs.writeFileSync(path.join(root, 'json.py'), '# inert module fixture\n');
  expect(evaluate(makeRuntime(), `python3 -c 'import json'`)).toMatchObject({decision:'required', actionKey:'bash:fetched-code'});
});

test('failed inline inspection cannot certify isolated imports', () => {
  expect(analyze(`python3 -I -c '${'#'.repeat(32769)}'`).runs).toBe(true);
});

test('a symlinked script directory cannot hide the downloaded module', () => {
  fs.mkdirSync(path.join(root, 'actual'));
  fs.writeFileSync(path.join(root, 'actual', 'json.py'), '# fixture');
  fs.symlinkSync(path.join(root, 'actual'), path.join(root, 'alias'));
  expect(analyze('python3 alias/local.py', ['actual/json.py']).runs).toBe(true);
});

test('a script symlink uses the target script directory', () => {
  fs.mkdirSync(path.join(root, 'actual'));
  fs.writeFileSync(path.join(root, 'actual', 'local.py'), 'import json');
  fs.symlinkSync(path.join(root, 'actual', 'local.py'), path.join(root, 'linked.py'));
  expect(analyze('python3 linked.py', ['actual/json.py']).runs).toBe(true);
});

test('a real script in another directory keeps its ordinary decision', () => {
  fs.mkdirSync(path.join(root, 'safe'));
  fs.writeFileSync(path.join(root, 'safe', 'local.py'), 'import json');
  fs.writeFileSync(path.join(root, 'json.py'), '# fixture');
  expect(analyze(`python3 ${JSON.stringify(path.join(root, 'safe', 'local.py'))}`, [path.join(root, 'json.py')]).runs).toBe(false);
});

test.each([
  `python3 -c "import sys; sys.path.insert(0, 'downloads'); import json"`,
  `python3 -c "__import__('downloads.json')"`,
])('explicit loaders retain provenance from another directory: %s', command => {
  expect(analyze(command, ['downloads/json.py']).runs).toBe(true);
});

test.each([
  {source: 'print(7)', review: false},
  {source: 'import json', review: true},
  {source: `exec(open("local.py").read())`, review: true},
])('unknown origins retain review without blocking import-free data: $source', ({source, review}) => {
  expect(analyze(`python3 -c '${source}'`, ['\0unknown-fetch-location']).runs).toBe(review);
});
