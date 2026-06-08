import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { logger } from '../logger.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readVersionFromPackageJson(packageJsonPath: string): string | null {
  try {
    const raw = fs.readFileSync(packageJsonPath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (
      isRecord(parsed) &&
      typeof parsed.version === 'string' &&
      parsed.version.trim()
    ) {
      return parsed.version.trim();
    }
  } catch {
    // fall through
  }
  return null;
}

function resolveAppVersion(): string {
  const envVersion = process.env.npm_package_version;
  if (envVersion?.trim()) return envVersion.trim();

  const modulePath = fileURLToPath(import.meta.url);
  const probePaths = [
    path.join(path.dirname(modulePath), '..', '..', 'package.json'),
  ];
  const moduleVersion = readVersionFromPackageJson(probePaths[0]);
  if (moduleVersion) return moduleVersion;

  const entryPath = process.argv[1];
  if (entryPath) {
    const entryPackagePath = path.join(
      path.dirname(path.resolve(entryPath)),
      '..',
      'package.json',
    );
    probePaths.push(entryPackagePath);
    const entryVersion = readVersionFromPackageJson(entryPackagePath);
    if (entryVersion) return entryVersion;
  }

  const cwdPackagePath = path.join(process.cwd(), 'package.json');
  probePaths.push(cwdPackagePath);
  const cwdVersion = readVersionFromPackageJson(cwdPackagePath);
  if (cwdVersion) return cwdVersion;

  logger.warn(
    { probePaths: Array.from(new Set(probePaths)) },
    'Unable to resolve app version from package.json probes; falling back to 0.0.0',
  );
  return '0.0.0';
}

export const APP_VERSION = resolveAppVersion();
