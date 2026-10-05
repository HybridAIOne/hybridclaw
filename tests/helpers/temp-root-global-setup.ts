import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A run owns its scratch directory, including legacy fixtures and subprocess
// output that bypass per-test cleanup. Other test runs keep separate roots.
export function setup(): () => void {
  const keys = ['TMPDIR', 'TMP', 'TEMP'] as const;
  const original = new Map(keys.map((key) => [key, process.env[key]]));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-tests-'));
  for (const key of keys) process.env[key] = root;

  return () => {
    try {
      fs.rmSync(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      });
    } finally {
      for (const [key, value] of original) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  };
}
