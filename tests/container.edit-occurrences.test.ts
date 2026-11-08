import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.js';

const temporary = useTempDir('edit-occurrences-');
useCleanMocks({ unstubAllEnvs: true, resetModules: true });
let root: string;
beforeEach(() => {
  root = temporary();
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', root);
  vi.stubEnv('HYBRIDCLAW_AGENT_STATE_ROOT', root);
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_DISPLAY_ROOT', root);
});

test.each([
  {
    label: 'identical replacement still advances',
    original: 'cat cat',
    old: 'cat',
    new: 'cat',
    count: 3,
    expected: 'cat cat',
    replacements: 2,
  },
  {
    label: 'large valid count stops at the original end',
    original: 'cat cat',
    old: 'cat',
    new: 'cat dog',
    count: Number.MAX_SAFE_INTEGER,
    expected: 'cat dog cat dog',
    replacements: 2,
  },
  {
    label: 'Unicode and line endings remain exact',
    original: 'café\r\ncafé\r\n',
    old: 'café',
    new: 'café ☕',
    count: 2,
    expected: 'café ☕\r\ncafé ☕\r\n',
    replacements: 2,
  },
  {
    label: 'replacement contains the search',
    original: 'cat cat cat',
    old: 'cat',
    new: 'cat dog',
    count: 2,
    expected: 'cat dog cat dog cat',
    replacements: 2,
  },
  {
    label: 'replacement creates an earlier boundary match',
    original: 'aaab ab',
    old: 'ab',
    new: 'b',
    count: 2,
    expected: 'aab b',
    replacements: 2,
  },
  {
    label: 'deletion creates an earlier match',
    original: 'aabb ab',
    old: 'ab',
    new: '',
    count: 2,
    expected: 'ab ',
    replacements: 2,
  },
  {
    label: 'count exceeds available matches',
    original: 'cat',
    old: 'cat',
    new: 'dog',
    count: 3,
    expected: 'dog',
    replacements: 1,
  },
  {
    label: 'default is one',
    original: 'cat cat',
    old: 'cat',
    new: 'dog',
    expected: 'dog cat',
    replacements: 1,
  },
  {
    label: 'nonoverlapping matches',
    original: 'aaa',
    old: 'aa',
    new: 'b',
    count: 2,
    expected: 'ba',
    replacements: 1,
  },
  {
    label: 'replacement syntax stays literal',
    original: 'a a',
    old: 'a',
    new: '$&$1',
    count: 2,
    expected: '$&$1 $&$1',
    replacements: 2,
  },
])('edit uses original occurrences: $label', async (row) => {
  fs.writeFileSync(path.join(root, 'notes.txt'), row.original);
  const { executeToolWithMetadata } = await import('../container/src/tools.js');
  const result = await executeToolWithMetadata(
    'edit',
    JSON.stringify({
      path: 'notes.txt',
      old: row.old,
      new: row.new,
      count: row.count,
    }),
  );
  expect(result.isError).toBe(false);
  expect(fs.readFileSync(path.join(root, 'notes.txt'), 'utf8')).toBe(
    row.expected,
  );
  expect(result.output).toContain(`(${row.replacements} replacement`);
});

test.each(
  [0, -1, 1.5, '2', null, true, [], {}, Number.MAX_SAFE_INTEGER + 1].map(
    (count) => ({ count }),
  ),
)('invalid edit count $count cannot change a file', async ({ count }) => {
  const file = path.join(root, 'notes.txt');
  fs.writeFileSync(file, 'cat cat');
  const { executeToolWithMetadata } = await import('../container/src/tools.js');
  const result = await executeToolWithMetadata(
    'edit',
    JSON.stringify({ path: 'notes.txt', old: 'cat', new: 'dog', count }),
  );
  expect(result.isError).toBe(true);
  expect(fs.readFileSync(file, 'utf8')).toBe('cat cat');
  expect(fs.readdirSync(root)).toEqual(['notes.txt']);
});

test('an absent match leaves the original unchanged', async () => {
  const file = path.join(root, 'notes.txt');
  fs.writeFileSync(file, 'cat cat');
  const { executeToolWithMetadata } = await import('../container/src/tools.js');
  const result = await executeToolWithMetadata(
    'edit',
    JSON.stringify({ path: 'notes.txt', old: 'bird', new: 'dog', count: 2 }),
  );
  expect(result.isError).toBe(true);
  expect(fs.readFileSync(file, 'utf8')).toBe('cat cat');
});
