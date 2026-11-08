import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.js';

const temporary = useTempDir('memory-literal-');
useCleanMocks({
  unstubAllEnvs: true,
  resetModules: true,
  cleanup: () => vi.useRealTimers(),
});
let file: string;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-01-15T12:00:00Z'));
  const root = temporary();
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', root);
  vi.stubEnv('HYBRIDCLAW_AGENT_STATE_ROOT', root);
  fs.writeFileSync(path.join(root, 'USER.md'), '- **Timezone:** UTC\n');
  fs.mkdirSync(path.join(root, 'memory'));
  file = path.join(root, 'memory/2026-01-15.md');
  fs.writeFileSync(file, 'Keep: alpha\nEnd.\n');
});

test.each(['$&', '$$', '$`', "$'", '$1', 'beta', ''])(
  'memory inserts replacement text literally: %j',
  async (new_text) => {
    const { executeToolWithMetadata } = await import(
      '../container/src/tools.js'
    );
    const result = await executeToolWithMetadata(
      'memory',
      JSON.stringify({ action: 'replace', old_text: 'alpha', new_text }),
    );
    expect(result.isError).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toBe(`Keep: ${new_text}\nEnd.\n`);
  },
);
