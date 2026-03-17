import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, DB_PATH } from '../../config/config.js';
import type { DiagResult } from '../types.js';
import {
  formatBytes,
  makeResult,
  readDirSize,
  readDiskFreeBytes,
} from '../utils.js';

export async function checkDisk(): Promise<DiagResult[]> {
  const freeBytes = readDiskFreeBytes(DATA_DIR);
  const dbSize = fs.existsSync(DB_PATH) ? fs.statSync(DB_PATH).size : 0;
  const auditSize = readDirSize(path.join(DATA_DIR, 'audit'));
  return [
    makeResult(
      'disk',
      'Disk',
      freeBytes >= 100 * 1024 * 1024 ? 'ok' : 'error',
      `${formatBytes(freeBytes)} free, DB ${formatBytes(dbSize)}, audit ${formatBytes(auditSize)}`,
    ),
  ];
}
