/**
 * CLI bootstrap rejects unsupported runtimes before its application graph loads.
 * Unlike node-version.ts, importing this module enforces the check and may exit.
 */
import type { NodeVersionCheck } from '../container/shared/node-version.js';
import { checkNodeVersion } from './node-version.js';

export function enforceNodeVersion(
  check: NodeVersionCheck = checkNodeVersion(),
  reportError: (message: string) => void = (message) => console.error(message),
  exit: (code: number) => void = (code) => process.exit(code),
): void {
  if (check.ok) return;
  reportError(check.message ?? '');
  exit(1);
}

enforceNodeVersion();
