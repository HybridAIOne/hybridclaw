import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.js';

const temporary = useTempDir('edit-replacement-');
useCleanMocks({ unstubAllEnvs: true, resetModules: true });
let root: string;
const original = 'Keep: alpha\r\nRemove: sample\r\n';
beforeEach(() => {
  root = temporary();
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', root);
  vi.stubEnv('HYBRIDCLAW_AGENT_STATE_ROOT', root);
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_DISPLAY_ROOT', root);
  fs.writeFileSync(path.join(root, 'notes.txt'), original, { mode: 0o640 });
});

const invalid = [
  { label: 'missing', args: {} },
  ...['new', 'new_text'].flatMap((key) =>
    [null, 0, false, [], {}].map((value) => ({
      label: `${key}=${JSON.stringify(value)}`,
      args: { [key]: value },
    })),
  ),
];
test.each(invalid)(
  'invalid replacement $label cannot delete text or publish a file',
  async ({ args }) => {
    const file = path.join(root, 'notes.txt');
    const before = fs.statSync(file);
    const { executeToolWithMetadata } = await import(
      '../container/src/tools.js'
    );
    const result = await executeToolWithMetadata(
      'edit',
      JSON.stringify({ path: 'notes.txt', old: 'alpha', ...args }),
    );
    expect.soft(result.isError).toBe(true);
    expect.soft(fs.readFileSync(file, 'utf8')).toBe(original);
    expect(fs.statSync(file).ino).toBe(before.ino);
    expect(fs.statSync(file).mode & 0o777).toBe(0o640);
    expect(fs.readdirSync(root)).toEqual(['notes.txt']);
  },
);

test.each([
  { label: 'new', args: { new: 'beta' }, replacement: 'beta' },
  { label: 'alias', args: { new_text: 'beta' }, replacement: 'beta' },
  { label: 'explicit deletion', args: { new: '' }, replacement: '' },
  { label: 'explicit alias deletion', args: { new_text: '' }, replacement: '' },
  {
    label: 'valid primary takes precedence',
    args: { new: 'beta', new_text: false },
    replacement: 'beta',
  },
  {
    label: 'valid alias remains supported',
    args: { new: null, new_text: 'beta' },
    replacement: 'beta',
  },
])(
  'valid replacement $label remains available',
  async ({ args, replacement }) => {
    const { executeToolWithMetadata } = await import(
      '../container/src/tools.js'
    );
    const result = await executeToolWithMetadata(
      'edit',
      JSON.stringify({ path: 'notes.txt', old_text: 'alpha', ...args }),
    );
    expect(result.isError).toBe(false);
    expect(fs.readFileSync(path.join(root, 'notes.txt'), 'utf8')).toBe(
      original.replace('alpha', replacement),
    );
  },
);
