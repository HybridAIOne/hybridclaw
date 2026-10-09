/**
 * Gateway build diagnostics — the `build` block of `gateway status`.
 *
 * Source-vs-build freshness is only judged in a source checkout. A packaged
 * install ships `container/src/` beside `container/dist/` for image builds,
 * and npm extraction stamps both with install-time mtimes, so comparing them
 * there reports staleness that cannot exist.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { APP_VERSION } from '../config/app-version.js';
import { isSourceCheckout } from '../infra/install-root.js';
import type { GatewayStatus } from './gateway-types.js';

type GatewayBuildDiagnostics = NonNullable<GatewayStatus['build']>;
type GatewayBuildFileDiagnostics = GatewayBuildDiagnostics['files'][number];

const GATEWAY_PROCESS_STARTED_AT = new Date().toISOString();

const GATEWAY_BUILD_FILE_PAIRS: Array<{
  name: string;
  sourcePath: string;
  buildPath: string;
}> = [
  {
    name: 'cli',
    sourcePath: 'src/cli.ts',
    buildPath: 'dist/cli.js',
  },
  {
    name: 'gateway-service',
    sourcePath: 'src/gateway/gateway-service.ts',
    buildPath: 'dist/gateway/gateway-service.js',
  },
  {
    name: 'gateway-http-proxy',
    sourcePath: 'src/gateway/gateway-http-proxy.ts',
    buildPath: 'dist/gateway/gateway-http-proxy.js',
  },
  {
    name: 'container-tools',
    sourcePath: 'container/src/tools.ts',
    buildPath: 'container/dist/tools.js',
  },
];

function readFileModifiedAt(
  filePath: string,
): { timeMs: number; iso: string } | null {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    return {
      timeMs: stat.mtimeMs,
      iso: stat.mtime.toISOString(),
    };
  } catch {
    return null;
  }
}

function getBuildFileStatus(
  packageRoot: string,
  filePair: (typeof GATEWAY_BUILD_FILE_PAIRS)[number],
): GatewayBuildFileDiagnostics {
  const sourcePath = path.join(packageRoot, filePair.sourcePath);
  const buildPath = path.join(packageRoot, filePair.buildPath);
  const sourceModified = readFileModifiedAt(sourcePath);
  const buildModified = readFileModifiedAt(buildPath);
  let status: GatewayBuildFileDiagnostics['status'] = 'ok';
  if (!sourceModified) {
    status = 'missing_source';
  } else if (!buildModified) {
    status = 'missing_build';
  } else if (sourceModified.timeMs > buildModified.timeMs + 1000) {
    status = 'source_newer';
  }

  return {
    name: filePair.name,
    sourcePath,
    sourceModifiedAt: sourceModified?.iso ?? null,
    buildPath,
    buildModifiedAt: buildModified?.iso ?? null,
    status,
  };
}

function readGitValue(packageRoot: string, args: string[]): string | null {
  const result = spawnSync('git', args, {
    cwd: packageRoot,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 1000,
  });
  if (result.status !== 0) return null;
  const value = result.stdout.trim();
  return value || null;
}

function isStaleBuildStatus(status: GatewayBuildFileDiagnostics['status']) {
  return status === 'source_newer' || status === 'missing_build';
}

export function getGatewayBuildDiagnostics(
  packageRoot: string,
): GatewayBuildDiagnostics {
  const files = isSourceCheckout(packageRoot)
    ? GATEWAY_BUILD_FILE_PAIRS.map((filePair) =>
        getBuildFileStatus(packageRoot, filePair),
      )
    : [];
  const gitBranch = readGitValue(packageRoot, [
    'rev-parse',
    '--abbrev-ref',
    'HEAD',
  ]);

  return {
    version: APP_VERSION,
    gitCommit: readGitValue(packageRoot, ['rev-parse', '--verify', 'HEAD']),
    gitBranch: gitBranch === 'HEAD' ? null : gitBranch,
    packageRoot,
    entrypoint: process.argv[1] || null,
    cwd: process.cwd(),
    execPath: process.execPath,
    nodeVersion: process.version,
    pid: process.pid,
    ppid: process.ppid,
    startedAt: GATEWAY_PROCESS_STARTED_AT,
    staleBuild: files.some((file) => isStaleBuildStatus(file.status)),
    files,
  };
}
