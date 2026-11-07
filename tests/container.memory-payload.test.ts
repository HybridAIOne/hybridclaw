import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.js';
const temporary = useTempDir('memory-text-');
useCleanMocks({
  unstubAllEnvs: true,
  resetModules: true,
  cleanup: () => {
    vi.useRealTimers();
  },
});
let root: string;
let file: string;
const original = 'Keep: alpha\nEnd.\n';
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-01-15T12:00:00Z'));
  root = temporary();
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', root);
  vi.stubEnv('HYBRIDCLAW_AGENT_STATE_ROOT', root);
  fs.writeFileSync(path.join(root, 'USER.md'), '- **Timezone:** UTC\n');
  fs.mkdirSync(path.join(root, 'memory'));
  file = path.join(root, 'memory/2026-01-15.md');
  fs.writeFileSync(file, original);
});
test.each(
  ['write', 'replace'].flatMap((action) =>
    [undefined, null, 0, false, [], {}].map((value) => ({ action, value })),
  ),
)(
  'malformed memory $action payload $value cannot erase stored text',
  async ({ action, value }) => {
    const { executeToolWithMetadata } = await import(
      '../container/src/tools.js'
    );
    const result = await executeToolWithMetadata(
      'memory',
      JSON.stringify({
        action,
        target: 'daily',
        confirm_overwrite: true,
        old_text: 'alpha',
        [action === 'write' ? 'content' : 'new_text']: value,
      }),
    );
    expect.soft(result.isError).toBe(true);
    expect.soft(fs.readFileSync(file, 'utf8')).toBe(original);
    expect(fs.readdirSync(path.dirname(file))).toEqual(['2026-01-15.md']);
  },
);
test.each(['beta', ''])(
  'valid memory replacement remains available %j',
  async (new_text) => {
    const { executeToolWithMetadata } = await import(
      '../container/src/tools.js'
    );
    expect(
      await executeToolWithMetadata(
        'memory',
        JSON.stringify({ action: 'replace', old_text: 'alpha', new_text }),
      ),
    ).toMatchObject({ isError: false });
    expect(fs.readFileSync(file, 'utf8')).toBe(`Keep: ${new_text}\nEnd.\n`);
  },
);
test('explicit clearing still needs overwrite confirmation and remove remains usable', async () => {
  const { executeToolWithMetadata } = await import('../container/src/tools.js');
  expect(
    await executeToolWithMetadata(
      'memory',
      JSON.stringify({ action: 'write', content: '' }),
    ),
  ).toMatchObject({ isError: true });
  expect(fs.readFileSync(file, 'utf8')).toBe(original);
  expect(
    await executeToolWithMetadata(
      'memory',
      JSON.stringify({ action: 'remove', old_text: 'alpha' }),
    ),
  ).toMatchObject({ isError: false });
  expect(fs.readFileSync(file, 'utf8')).toBe('Keep: \nEnd.\n');
  expect(
    await executeToolWithMetadata(
      'memory',
      JSON.stringify({ action: 'write', content: '', confirm_overwrite: true }),
    ),
  ).toMatchObject({ isError: false });
  expect(fs.readFileSync(file, 'utf8')).toBe('');
});
