import fs from 'node:fs';
import { resolveInstallPath } from '../infra/install-root.js';
import { logger } from '../logger.js';
import { isRecord } from '../utils/type-guards.js';

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

  const packageJsonPath = resolveInstallPath('package.json');
  const version = readVersionFromPackageJson(packageJsonPath);
  if (version) return version;

  logger.warn(
    { packageJsonPath },
    'Unable to resolve app version from package.json; falling back to 0.0.0',
  );
  return '0.0.0';
}

export const APP_VERSION = resolveAppVersion();
