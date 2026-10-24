import { checkNodeVersion } from '../../node-version.js';
import type { DiagResult } from '../types.js';
import { makeResult, runVersionCommand } from '../utils.js';

export async function checkRuntime(): Promise<DiagResult[]> {
  const nodeCheck = checkNodeVersion();
  const npmVersion = runVersionCommand('npm');
  const pnpmVersion = runVersionCommand('pnpm');
  const severity = !nodeCheck.ok
    ? 'error'
    : npmVersion || pnpmVersion
      ? 'ok'
      : 'warn';
  const messageParts = [`Node.js v${process.versions.node}`];
  if (!nodeCheck.ok)
    messageParts.push(nodeCheck.message ?? 'Unsupported Node.js');
  messageParts.push(npmVersion ? `npm ${npmVersion}` : 'npm missing');
  messageParts.push(pnpmVersion ? `pnpm ${pnpmVersion}` : 'pnpm missing');
  return [makeResult('runtime', 'Runtime', severity, messageParts.join(', '))];
}
