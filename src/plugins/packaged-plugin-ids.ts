/**
 * Plugin ids the HybridClaw package ships, read from its own package.json
 * `files` entries under `plugins/`. A bare id in this set must never fall
 * through to an npm install: the public registry name is not ours, so a
 * bundled copy missing from an install (a trimmed Docker image, say) is an
 * error rather than a download of whatever someone published under that name.
 *
 * NOT plugin discovery: it says what the package claims to ship, not what is
 * on disk (`plugin-install.ts` scans the directories).
 */
import fs from 'node:fs';
import path from 'node:path';

export function isPackagedPluginId(packageRoot: string, id: string): boolean {
  let files: unknown;
  try {
    files = JSON.parse(
      fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf-8'),
    ).files;
  } catch {
    return false;
  }
  if (!Array.isArray(files)) return false;
  const wanted = `plugins/${id}`;
  return files.some((entry) => String(entry).replace(/\/+$/, '') === wanted);
}
