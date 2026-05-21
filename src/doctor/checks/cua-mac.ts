import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DiagResult } from '../types.js';
import { makeResult, shortenHomePath } from '../utils.js';

const ACCESSIBILITY_DEEP_LINK =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility';
const SCREEN_RECORDING_DEEP_LINK =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';

export interface CuaMacProbeInput {
  platform?: NodeJS.Platform;
  driverPath?: string | null;
  accessibilityGranted?: boolean;
  screenRecordingGranted?: boolean;
  permissionProbeError?: string;
}

function resolvePathBinary(command: string): string | null {
  if (path.isAbsolute(command)) {
    try {
      fs.accessSync(command, fs.constants.X_OK);
      return command;
    } catch {
      return null;
    }
  }
  const result = spawnSync('which', [command], { encoding: 'utf-8' });
  return result.status === 0 && result.stdout.trim()
    ? result.stdout.trim()
    : null;
}

export function resolveCuaDriverPath(): string | null {
  const configured = process.env.HYBRIDAI_CUA_DRIVER_BIN?.trim();
  if (configured) return resolvePathBinary(configured);
  return resolvePathBinary('cua-driver');
}

function probeCuaDriverPermissions(
  driverPath: string,
): Pick<
  CuaMacProbeInput,
  'accessibilityGranted' | 'screenRecordingGranted' | 'permissionProbeError'
> {
  const doctorResult = spawnSync(driverPath, ['doctor', '--json'], {
    encoding: 'utf-8',
    timeout: 10_000,
  });
  if (doctorResult.status === 0) {
    try {
      const payload = JSON.parse(doctorResult.stdout) as Record<
        string,
        unknown
      >;
      return {
        accessibilityGranted: payload.accessibilityGranted === true,
        screenRecordingGranted: payload.screenRecordingGranted === true,
      };
    } catch (error) {
      return {
        permissionProbeError: `cua-driver doctor returned invalid JSON: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  }

  const permissionsResult = spawnSync(driverPath, ['check_permissions'], {
    encoding: 'utf-8',
    timeout: 10_000,
  });
  if (permissionsResult.status === 0) {
    const parsed = parseCheckPermissionsOutput(
      `${permissionsResult.stdout}\n${permissionsResult.stderr}`,
    );
    if (parsed) return parsed;
    return {
      permissionProbeError:
        'cua-driver check_permissions did not report Accessibility and Screen Recording status.',
    };
  }

  return {
    permissionProbeError:
      doctorResult.stderr.trim() ||
      permissionsResult.stderr.trim() ||
      `cua-driver doctor exited with ${doctorResult.status}`,
  };
}

function parsePermissionLine(output: string, label: string): boolean | null {
  const match = new RegExp(`${label}:\\s*(granted|not granted)`, 'iu').exec(
    output,
  );
  if (!match?.[1]) return null;
  return match[1].toLowerCase() === 'granted';
}

export function parseCheckPermissionsOutput(
  output: string,
): Pick<
  CuaMacProbeInput,
  'accessibilityGranted' | 'screenRecordingGranted'
> | null {
  const accessibilityGranted = parsePermissionLine(output, 'Accessibility');
  const screenRecordingGranted = parsePermissionLine(
    output,
    'Screen Recording',
  );
  if (accessibilityGranted === null || screenRecordingGranted === null) {
    return null;
  }
  return {
    accessibilityGranted,
    screenRecordingGranted,
  };
}

export function buildCuaMacResults(input: CuaMacProbeInput = {}): DiagResult[] {
  const platform = input.platform || os.platform();
  if (platform !== 'darwin') {
    return [
      makeResult(
        'cua-mac',
        'Mac CUA',
        'warn',
        'mac-cua browser provider is only supported on macOS.',
      ),
    ];
  }

  const driverPath =
    input.driverPath === undefined ? resolveCuaDriverPath() : input.driverPath;
  const results: DiagResult[] = [];
  if (!driverPath) {
    results.push(
      makeResult(
        'cua-mac',
        'CUA driver',
        'error',
        'cua-driver is not installed or HYBRIDAI_CUA_DRIVER_BIN does not point to an executable.',
      ),
    );
    return results;
  }

  results.push(
    makeResult(
      'cua-mac',
      'CUA driver',
      'ok',
      `cua-driver available at ${shortenHomePath(driverPath)}`,
    ),
  );

  const permissions =
    input.accessibilityGranted === undefined &&
    input.screenRecordingGranted === undefined &&
    input.permissionProbeError === undefined
      ? probeCuaDriverPermissions(driverPath)
      : input;

  if (permissions.permissionProbeError) {
    results.push(
      makeResult(
        'cua-mac',
        'macOS permissions',
        'warn',
        `Unable to verify Accessibility and Screen Recording grants: ${permissions.permissionProbeError}`,
      ),
    );
    return results;
  }

  const missing: string[] = [];
  if (permissions.accessibilityGranted !== true) {
    missing.push(`Accessibility (${ACCESSIBILITY_DEEP_LINK})`);
  }
  if (permissions.screenRecordingGranted !== true) {
    missing.push(`Screen Recording (${SCREEN_RECORDING_DEEP_LINK})`);
  }

  if (missing.length > 0) {
    results.push(
      makeResult(
        'cua-mac',
        'macOS permissions',
        'error',
        `Missing macOS TCC grants for ${missing.join(' and ')}. mac-cua will not be advertised until both grants are present.`,
      ),
    );
    return results;
  }

  results.push(
    makeResult(
      'cua-mac',
      'macOS permissions',
      'ok',
      'Accessibility and Screen Recording grants are present; mac-cua can be advertised.',
    ),
  );
  return results;
}

export async function checkCuaMac(): Promise<DiagResult[]> {
  return buildCuaMacResults();
}
