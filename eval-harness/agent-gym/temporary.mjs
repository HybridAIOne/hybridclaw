// Register each scratch directory and remove it after its owner's resources close.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const registered = new Set();
export async function withTemporaryDirectory(prefix, work) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  registered.add(directory);
  try {
    return await work(directory);
  } finally {
    fs.rmSync(directory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
    registered.delete(directory);
  }
}
