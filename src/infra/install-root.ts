import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_NAME = '@hybridaione/hybridclaw';

let cachedInstallRoot: string | null = null;

function readPackageName(packageJsonPath: string): string | null {
  try {
    const raw = fs.readFileSync(packageJsonPath, 'utf-8');
    const parsed = JSON.parse(raw) as { name?: unknown };
    return typeof parsed.name === 'string' && parsed.name.trim()
      ? parsed.name.trim()
      : null;
  } catch {
    return null;
  }
}

export function findNearestPackageRoot(
  startPath: string | undefined,
): string | null {
  if (!startPath) return null;

  let current: string;
  try {
    const resolved = path.resolve(startPath);
    current =
      fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()
        ? resolved
        : path.dirname(resolved);
  } catch {
    return null;
  }

  for (;;) {
    if (fs.existsSync(path.join(current, 'package.json'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function resolveInstallRoot(): string {
  if (cachedInstallRoot) return cachedInstallRoot;

  let current = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const packageJsonPath = path.join(current, 'package.json');
    if (readPackageName(packageJsonPath) === PACKAGE_NAME) {
      cachedInstallRoot = current;
      return cachedInstallRoot;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  const entryRoot = findNearestPackageRoot(process.argv[1]);
  if (
    entryRoot &&
    readPackageName(path.join(entryRoot, 'package.json')) === PACKAGE_NAME
  ) {
    cachedInstallRoot = entryRoot;
    return cachedInstallRoot;
  }

  const cwdRoot = findNearestPackageRoot(process.cwd());
  if (
    cwdRoot &&
    readPackageName(path.join(cwdRoot, 'package.json')) === PACKAGE_NAME
  ) {
    cachedInstallRoot = cwdRoot;
    return cachedInstallRoot;
  }

  cachedInstallRoot = process.cwd();
  return cachedInstallRoot;
}

export function resolveInstallPath(...segments: string[]): string {
  return path.join(resolveInstallRoot(), ...segments);
}
