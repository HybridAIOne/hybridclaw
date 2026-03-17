import fs from 'node:fs';
import {
  CONFIG_VERSION,
  ensureRuntimeConfigFile,
  getRuntimeConfig,
  runtimeConfigPath,
} from '../../config/runtime-config.js';
import type { DiagResult } from '../types.js';
import {
  buildChmodFix,
  formatMode,
  isGroupOrWorldWritable,
  makeResult,
  readUnixMode,
  shortenHomePath,
} from '../utils.js';

export async function checkConfig(): Promise<DiagResult[]> {
  const filePath = runtimeConfigPath();
  const displayPath = shortenHomePath(filePath);

  if (!fs.existsSync(filePath)) {
    return [
      makeResult('config', 'Config', 'error', `${displayPath} is missing`, {
        summary: `Create ${displayPath}`,
        apply: async () => {
          ensureRuntimeConfigFile();
        },
      }),
    ];
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
  } catch (error) {
    return [
      makeResult(
        'config',
        'Config',
        'error',
        `${displayPath} is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
      ),
    ];
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return [
      makeResult(
        'config',
        'Config',
        'error',
        `${displayPath} must contain a top-level object`,
      ),
    ];
  }

  const config = getRuntimeConfig();
  const mode = readUnixMode(filePath);
  const writableByOthers = isGroupOrWorldWritable(mode);
  const missingFields = [
    config.hybridai.defaultModel.trim() ? null : 'hybridai.defaultModel',
    config.ops.dbPath.trim() ? null : 'ops.dbPath',
    config.container.image.trim() ? null : 'container.image',
  ].filter(Boolean) as string[];

  if (missingFields.length > 0) {
    return [
      makeResult(
        'config',
        'Config',
        'error',
        `${displayPath} missing required field${missingFields.length === 1 ? '' : 's'}: ${missingFields.join(', ')}`,
      ),
    ];
  }

  const version =
    typeof (raw as { version?: unknown }).version === 'number'
      ? (raw as { version: number }).version
      : null;
  const severity = writableByOthers ? 'warn' : 'ok';
  const message =
    version === CONFIG_VERSION
      ? `${displayPath} valid (v${CONFIG_VERSION})${writableByOthers ? `, permissions ${formatMode(mode)}` : ''}`
      : `${displayPath} valid${version == null ? '' : ` (v${version})`}${writableByOthers ? `, permissions ${formatMode(mode)}` : ''}`;

  return [
    makeResult(
      'config',
      'Config',
      severity,
      message,
      writableByOthers
        ? buildChmodFix(filePath, 0o644, `Restrict ${displayPath} permissions`)
        : undefined,
    ),
  ];
}
