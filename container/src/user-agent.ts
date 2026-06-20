import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function readVersionFromPackageJson(packageJsonPath: string): string | null {
  try {
    const raw = fs.readFileSync(packageJsonPath, 'utf-8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    if (typeof parsed.version === 'string' && parsed.version.trim()) {
      return parsed.version.trim();
    }
  } catch {
    // fall through
  }
  return null;
}

function resolveHybridClawVersion(): string {
  const envVersion =
    process.env.HYBRIDCLAW_VERSION?.trim() ||
    process.env.npm_package_version?.trim();
  if (envVersion) return envVersion;

  const modulePath = fileURLToPath(import.meta.url);
  const packageJsonPath = path.join(
    path.dirname(modulePath),
    '..',
    'package.json',
  );
  return readVersionFromPackageJson(packageJsonPath) || '0.0.0';
}

export function buildHybridClawUserAgent(
  version = resolveHybridClawVersion(),
): string {
  const normalized = String(version || '').trim() || '0.0.0';
  return `hybridclaw/${normalized}`;
}

export const HYBRIDCLAW_USER_AGENT = buildHybridClawUserAgent();
