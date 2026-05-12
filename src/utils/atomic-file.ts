import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function writeFileAtomicExclusive(
  targetPath: string,
  content: string,
  options: {
    tempPrefix: string;
    dirMode?: number;
    fileMode?: number;
  },
): void {
  const targetDir = path.dirname(targetPath);
  fs.mkdirSync(targetDir, {
    recursive: true,
    ...(options.dirMode === undefined ? {} : { mode: options.dirMode }),
  });
  const tempPath = path.join(
    targetDir,
    `.${options.tempPrefix}-${randomUUID()}.tmp`,
  );
  try {
    fs.writeFileSync(tempPath, content, {
      encoding: 'utf-8',
      flag: 'wx',
      mode: options.fileMode ?? 0o600,
    });
    fs.linkSync(tempPath, targetPath);
    fs.chmodSync(targetPath, options.fileMode ?? 0o600);
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
}
