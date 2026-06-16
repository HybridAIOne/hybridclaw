import type { FileHandle } from 'node:fs/promises';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getRuntimeConfig } from '../config/runtime-config.js';
import { getLoggerRuntimeState } from '../logger.js';
import {
  GATEWAY_DEBUG_MODEL_RESPONSES_ENV,
  GATEWAY_LOG_PATH,
  GATEWAY_LOG_REQUESTS_ENV,
  GATEWAY_MODEL_RESPONSE_DEBUG_PATH,
} from './gateway-lifecycle.js';

const DEFAULT_TAIL_BYTES = 64 * 1024;
const MAX_TAIL_BYTES = 256 * 1024;
const ENABLED_ENV_VALUE = '1';

export interface GatewayAdminLogFile {
  id: string;
  label: string;
  path: string;
  exists: boolean;
  readable: boolean;
  sizeBytes: number | null;
  mtime: string | null;
  description: string;
  error: string | null;
}

export interface GatewayAdminLogTail {
  fileId: string;
  content: string;
  tailBytes: number;
  truncated: boolean;
}

export interface GatewayAdminLoggingState {
  configuredLevel: ReturnType<typeof getRuntimeConfig>['ops']['logLevel'];
  effectiveLevel: ReturnType<typeof getRuntimeConfig>['ops']['logLevel'];
  forcedLevel: ReturnType<typeof getRuntimeConfig>['ops']['logLevel'] | null;
  logRequests: {
    configured: boolean;
    envEnabled: boolean;
    effective: boolean;
  };
  debugModelResponses: {
    configured: boolean;
    envEnabled: boolean;
    effective: boolean;
  };
}

export interface GatewayAdminLogsResponse {
  files: GatewayAdminLogFile[];
  selected: GatewayAdminLogTail | null;
  logging: GatewayAdminLoggingState;
}

interface LogDescriptor {
  id: string;
  label: string;
  path: string;
  description: string;
}

function getLogDescriptors(): LogDescriptor[] {
  const descriptors: LogDescriptor[] = [
    {
      id: 'gateway',
      label: 'Gateway',
      path: GATEWAY_LOG_PATH,
      description: 'Gateway process stdout/stderr and structured runtime logs.',
    },
    {
      id: 'model-responses',
      label: 'Model responses',
      path: GATEWAY_MODEL_RESPONSE_DEBUG_PATH,
      description:
        'Optional model response debug log, present only when debug capture is enabled.',
    },
  ];

  const configuredGatewayLog = String(
    process.env.HYBRIDCLAW_GATEWAY_LOG_FILE || '',
  ).trim();
  if (configuredGatewayLog) {
    const resolved = path.resolve(configuredGatewayLog);
    if (!descriptors.some((entry) => path.resolve(entry.path) === resolved)) {
      descriptors.unshift({
        id: 'configured-gateway',
        label: 'Configured gateway',
        path: resolved,
        description:
          'Gateway log file configured through HYBRIDCLAW_GATEWAY_LOG_FILE.',
      });
    }
  }

  return descriptors;
}

function normalizeTailBytes(value: string | null): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_TAIL_BYTES;
  return Math.max(1, Math.min(Math.trunc(parsed), MAX_TAIL_BYTES));
}

async function describeLogFile(
  descriptor: LogDescriptor,
): Promise<GatewayAdminLogFile> {
  try {
    const stat = await fs.stat(descriptor.path);
    return {
      id: descriptor.id,
      label: descriptor.label,
      path: descriptor.path,
      exists: true,
      readable: stat.isFile(),
      sizeBytes: stat.size,
      mtime: stat.mtime.toISOString(),
      description: descriptor.description,
      error: stat.isFile() ? null : 'Path exists but is not a regular file.',
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      id: descriptor.id,
      label: descriptor.label,
      path: descriptor.path,
      exists: false,
      readable: false,
      sizeBytes: null,
      mtime: null,
      description: descriptor.description,
      error: code === 'ENOENT' ? null : errorMessage(error),
    };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readLogTail(
  descriptor: LogDescriptor,
  tailBytes: number,
): Promise<GatewayAdminLogTail | null> {
  let handle: FileHandle | null = null;
  try {
    const stat = await fs.stat(descriptor.path);
    if (!stat.isFile()) return null;
    const bytesToRead = Math.min(stat.size, tailBytes);
    const buffer = Buffer.alloc(bytesToRead);
    handle = await fs.open(descriptor.path, 'r');
    await handle.read(buffer, 0, bytesToRead, stat.size - bytesToRead);
    return {
      fileId: descriptor.id,
      content: buffer.toString('utf-8'),
      tailBytes: bytesToRead,
      truncated: stat.size > bytesToRead,
    };
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function isEnvFlagEnabled(name: string): boolean {
  return String(process.env[name] || '').trim() === ENABLED_ENV_VALUE;
}

function getGatewayAdminLoggingState(): GatewayAdminLoggingState {
  const config = getRuntimeConfig();
  const loggerState = getLoggerRuntimeState();
  const logRequestsEnvEnabled = isEnvFlagEnabled(GATEWAY_LOG_REQUESTS_ENV);
  const debugModelResponsesEnvEnabled = isEnvFlagEnabled(
    GATEWAY_DEBUG_MODEL_RESPONSES_ENV,
  );

  return {
    configuredLevel: loggerState.configuredLevel,
    effectiveLevel: loggerState.effectiveLevel,
    forcedLevel: loggerState.forcedLevel,
    logRequests: {
      configured: config.ops.logRequests === true,
      envEnabled: logRequestsEnvEnabled,
      effective: config.ops.logRequests === true || logRequestsEnvEnabled,
    },
    debugModelResponses: {
      configured: config.ops.debugModelResponses === true,
      envEnabled: debugModelResponsesEnvEnabled,
      effective:
        config.ops.debugModelResponses === true ||
        debugModelResponsesEnvEnabled,
    },
  };
}

export async function getGatewayAdminLogs(options?: {
  fileId?: string | null;
  tailBytes?: string | null;
}): Promise<GatewayAdminLogsResponse> {
  const descriptors = getLogDescriptors();
  const files = await Promise.all(descriptors.map(describeLogFile));
  const requestedFileId = options?.fileId?.trim() || '';
  const selectedDescriptor = requestedFileId
    ? descriptors.find((entry) => entry.id === requestedFileId)
    : (descriptors.find((entry) =>
        files.some((file) => file.id === entry.id && file.readable),
      ) ?? descriptors[0]);

  if (!selectedDescriptor) {
    return {
      files,
      selected: null,
      logging: getGatewayAdminLoggingState(),
    };
  }
  if (requestedFileId && selectedDescriptor.id !== requestedFileId) {
    throw new Error(`Unknown log file "${requestedFileId}".`);
  }

  const selected = await readLogTail(
    selectedDescriptor,
    normalizeTailBytes(options?.tailBytes ?? null),
  );
  return {
    files,
    selected,
    logging: getGatewayAdminLoggingState(),
  };
}
