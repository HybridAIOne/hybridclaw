import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DiagResult, DoctorCategory, DoctorReport } from './types.js';
import { DOCTOR_CATEGORIES, SEVERITY_ORDER } from './types.js';

export function shortenHomePath(filePath: string): string {
  const homeDir = os.homedir();
  return filePath.startsWith(homeDir)
    ? `~${filePath.slice(homeDir.length)}`
    : filePath;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const digits = value >= 10 || unitIndex === 0 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unitIndex]}`;
}

export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

export function formatMode(mode: number | null): string {
  if (mode == null) return 'unknown';
  return `0${(mode & 0o777).toString(8)}`;
}

export function readUnixMode(filePath: string): number | null {
  try {
    return fs.statSync(filePath).mode;
  } catch {
    return null;
  }
}

export function isGroupOrWorldWritable(mode: number | null): boolean {
  return mode != null && (mode & 0o022) !== 0;
}

export function isGroupOrWorldReadable(mode: number | null): boolean {
  return mode != null && (mode & 0o044) !== 0;
}

export function findExistingPath(filePath: string): string {
  let current = path.resolve(filePath);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return filePath;
    current = parent;
  }
  return current;
}

export function readDiskFreeBytes(targetPath: string): number {
  const stat = fs.statfsSync(findExistingPath(targetPath));
  return Number(stat.bavail) * Number(stat.bsize);
}

export function readDirSize(dirPath: string): number {
  if (!fs.existsSync(dirPath)) return 0;
  const stat = fs.statSync(dirPath);
  if (stat.isFile()) return stat.size;
  if (!stat.isDirectory()) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    total += readDirSize(path.join(dirPath, entry.name));
  }
  return total;
}

export function runVersionCommand(command: string): string | null {
  const result = spawnSync(command, ['--version'], {
    encoding: 'utf-8',
  });
  if (result.error || result.status !== 0) return null;
  const value = `${result.stdout || ''}`.trim();
  return value || null;
}

export function severityFrom(
  values: DiagResult['severity'][],
): DiagResult['severity'] {
  let current: DiagResult['severity'] = 'ok';
  for (const value of values) {
    if (SEVERITY_ORDER[value] > SEVERITY_ORDER[current]) current = value;
  }
  return current;
}

export function makeResult(
  category: DoctorCategory,
  label: string,
  severity: DiagResult['severity'],
  message: string,
  fix?: DiagResult['fix'],
): DiagResult {
  return {
    category,
    label,
    severity,
    message,
    ...(fix ? { fix } : {}),
  };
}

export function summarizeCounts(
  results: DiagResult[],
): DoctorReport['summary'] {
  const summary = {
    ok: 0,
    warn: 0,
    error: 0,
    exitCode: 0,
  };
  for (const result of results) {
    summary[result.severity] += 1;
  }
  summary.exitCode = summary.error > 0 ? 1 : 0;
  return summary;
}

export function normalizeComponent(
  raw: string | null | undefined,
): DoctorCategory | null {
  const value = String(raw || '')
    .trim()
    .toLowerCase();
  if (!value) return null;

  const aliasMap: Record<string, DoctorCategory> = {
    runtime: 'runtime',
    gateway: 'gateway',
    config: 'config',
    configuration: 'config',
    credentials: 'credentials',
    creds: 'credentials',
    secrets: 'credentials',
    db: 'database',
    database: 'database',
    provider: 'providers',
    providers: 'providers',
    local: 'local-backends',
    backend: 'local-backends',
    backends: 'local-backends',
    'local-backends': 'local-backends',
    localbackends: 'local-backends',
    docker: 'docker',
    container: 'docker',
    channels: 'channels',
    channel: 'channels',
    security: 'security',
    disk: 'disk',
    storage: 'disk',
  };
  return aliasMap[value] || null;
}

export function normalizeDoctorComponentList(): string {
  return DOCTOR_CATEGORIES.join(', ');
}

export function buildChmodFix(
  filePath: string,
  mode: number,
  summary: string,
): NonNullable<DiagResult['fix']> {
  const previousMode = readUnixMode(filePath);
  return {
    summary,
    apply: async () => {
      fs.chmodSync(filePath, mode);
    },
    rollback:
      previousMode == null
        ? undefined
        : async () => {
            fs.chmodSync(filePath, previousMode & 0o777);
          },
  };
}
