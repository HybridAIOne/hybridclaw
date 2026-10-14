/**
 * Health and Contacts exclude this runtime from improvement pipelines.
 * The exclusion survives disconnects because answers and memories can retain
 * derived content. It does not prevent processing requests for the user.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config/config.js';

export const deviceDataStorePath = () =>
  path.join(DATA_DIR, 'device-data.json');

export function containsProtectedDeviceSources(
  sources: Iterable<Record<string, unknown>>,
): boolean {
  return [...sources].some(
    (source) =>
      !source ||
      typeof source !== 'object' ||
      Array.isArray(source) ||
      'health' in source ||
      'contacts' in source,
  );
}

export function deviceDataExcludesImprovement(): boolean {
  try {
    const stored = JSON.parse(
      fs.readFileSync(deviceDataStorePath(), 'utf8'),
    ) as {
      version?: number;
      excludeFromImprovement?: boolean;
      users?: Record<string, Record<string, unknown>>;
    };
    if (
      stored.version !== 1 ||
      !stored.users ||
      typeof stored.users !== 'object' ||
      Array.isArray(stored.users)
    ) {
      return true;
    }
    return (
      stored.excludeFromImprovement === true ||
      containsProtectedDeviceSources(Object.values(stored.users))
    );
  } catch (error) {
    // Unreadable state must never enable collection.
    return (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}
