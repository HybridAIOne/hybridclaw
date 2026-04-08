import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test } from 'vitest';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runMempalace reports when stderr output was truncated on non-zero exit', async () => {
  const cwd = makeTempDir('hybridclaw-mempalace-process-');
  const scriptPath = path.join(cwd, 'stderr-heavy.mjs');
  fs.writeFileSync(
    scriptPath,
    [
      'process.stderr.write("x".repeat(40000), () => {',
      '  process.exit(1);',
      '});',
      '',
    ].join('\n'),
    'utf-8',
  );

  const { runMempalace } = await import(
    '../plugins/mempalace-memory/src/mempalace-process.js'
  );

  const result = await runMempalace([scriptPath], {
    command: process.execPath,
    workingDirectory: cwd,
    palacePath: '',
    timeoutMs: 5000,
  });

  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error('Expected MemPalace runner to fail');
  }
  expect(result.stderrTruncated).toBe(true);
  expect(result.error.message).toContain('[stderr truncated]');
});
