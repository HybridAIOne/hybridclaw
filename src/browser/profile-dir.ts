import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config/config.js';
import { getBrowserProfileDir } from './browser-login.js';

export interface BrowserProfileRootOptions {
  dataDir?: string;
  profileRoot?: string;
}

function isPathWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // Some mounted filesystems ignore chmod; profile confinement still relies
    // on path validation before browsers receive the directory.
  }
}

export function resolveBrowserProfileRoot(
  options: BrowserProfileRootOptions = {},
): string {
  const envProfileRoot = process.env.BROWSER_SHARED_PROFILE_DIR?.trim();
  if (options.profileRoot) return path.resolve(options.profileRoot);
  if (options.dataDir)
    return path.resolve(getBrowserProfileDir(options.dataDir));
  if (envProfileRoot) return path.resolve(envProfileRoot);
  return path.resolve(getBrowserProfileDir(DATA_DIR));
}

function nearestExistingAncestor(targetPath: string): string {
  let current = path.resolve(targetPath);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

export function resolveConstrainedBrowserProfileDir(
  profileRoot: string,
  hint?: string,
): string {
  ensurePrivateDir(profileRoot);
  const rootPath = path.resolve(profileRoot);
  const realRoot = fs.realpathSync(profileRoot);
  const profileDir = path.resolve(hint || rootPath);

  if (
    !isPathWithin(rootPath, profileDir) &&
    !isPathWithin(realRoot, profileDir)
  ) {
    throw new Error(
      `Browser profile directory must stay under ${realRoot}: ${profileDir}`,
    );
  }

  if (profileDir === rootPath || profileDir === realRoot) return realRoot;

  const existingAncestor = nearestExistingAncestor(profileDir);
  const realAncestor = fs.realpathSync(existingAncestor);
  if (!isPathWithin(realRoot, realAncestor)) {
    throw new Error(
      `Browser profile directory resolves outside ${realRoot}: ${realAncestor}`,
    );
  }

  ensurePrivateDir(profileDir);

  const realProfileDir = fs.realpathSync(profileDir);
  if (!isPathWithin(realRoot, realProfileDir)) {
    throw new Error(
      `Browser profile directory resolves outside ${realRoot}: ${realProfileDir}`,
    );
  }

  return realProfileDir;
}
