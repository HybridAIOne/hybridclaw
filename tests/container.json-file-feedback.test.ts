import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { runFileWrite } from '../container/src/tools/file-write.js';
import { useCleanMocks, useTempDir } from './test-utils.js';

const makeTempDir = useTempDir();
useCleanMocks({ unstubAllEnvs: true, resetModules: true });

test.each([
  ['settings.json', '{"enabled":true}\n', false],
  ['settings.JSON', '{"label":"unfinished}', true],
  ['settings.json', '[1,]', true],
  ['settings.json', '', true],
  ['fixture.txt', '{]', false],
  ['fixture.jsonc', '// comment\n{}', false],
  ['value.json', '42', false],
])(
  'writing %s reports syntax without changing requested bytes',
  (name, contents, invalid) => {
    const root = makeTempDir('json-feedback-');
    const result = runFileWrite({ path: name, contents }, (p) =>
      path.join(root, p),
    );
    expect(result).toMatch(/^Wrote /);
    expect(result.includes('Warning:')).toBe(invalid);
    expect(fs.readFileSync(path.join(root, name), 'utf8')).toBe(contents);
  },
);

test('syntax feedback does not echo malformed secret-bearing content', () => {
  const root = makeTempDir('json-feedback-');
  const result = runFileWrite(
    {
      path: 'config.json',
      contents: '{"token":"private_fixture_value" invalid}',
    },
    (p) => path.join(root, p),
  );
  expect(result).toMatch(/Warning:.*JSON/);
  expect(result).not.toContain('private_fixture_value');
});

test.each(['x'.repeat(1_000_000), '界'.repeat(100_000)])(
  'large JSON writes remain available with explicit unchecked feedback',
  (data) => {
    const root = makeTempDir('json-feedback-');
    const contents = JSON.stringify({ data });
    const result = runFileWrite({ path: 'large.json', contents }, (p) =>
      path.join(root, p),
    );
    expect(result).toMatch(/not checked/);
    expect(fs.readFileSync(path.join(root, 'large.json'), 'utf8')).toBe(
      contents,
    );
  },
);

test('the task-sandbox write path reports the same syntax feedback', () => {
  const run = vi.fn(() => ({ status: 0, stdout: '', stderr: '' }));
  const result = runFileWrite(
    { path: 'fixture.json', contents: '{]' },
    (p) => `/workspace/${p}`,
    { container: 'fixture-worker', run },
  );
  expect(run).toHaveBeenCalledOnce();
  expect(result).toMatch(/^Wrote /);
  expect(result).toMatch(/Warning:.*JSON/);
});

test('edit reports invalid JSON and clears the warning after repair', async () => {
  const root = makeTempDir('json-edit-feedback-');
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', root);
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_DISPLAY_ROOT', root);
  vi.resetModules();
  const { executeTool } = await import('../container/src/tools.js');
  const file = path.join(root, 'result.json');
  fs.writeFileSync(file, '{"label":"before"}');
  const broken = '{"label":"unescaped "quote""}';
  const result = await executeTool(
    'edit',
    JSON.stringify({ path: file, old: '{"label":"before"}', new: broken }),
  );
  expect(result).toMatch(/^Edited /);
  expect(result).toMatch(/Warning:.*JSON/);
  expect(fs.readFileSync(file, 'utf8')).toBe(broken);
  const repaired = await executeTool(
    'edit',
    JSON.stringify({ path: file, old: broken, new: '{"label":"after"}' }),
  );
  expect(repaired).toMatch(/^Edited /);
  expect(repaired).not.toMatch(/Warning:/);
  expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ label: 'after' });
});
