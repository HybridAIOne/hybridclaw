import type { DiagResult } from '../types.js';
import { makeResult, runVersionCommand } from '../utils.js';

export async function checkRuntime(): Promise<DiagResult[]> {
  const nodeMajor = Number.parseInt(
    process.versions.node.split('.')[0] || '0',
    10,
  );
  const npmVersion = runVersionCommand('npm');
  const pnpmVersion = runVersionCommand('pnpm');
  const severity =
    nodeMajor < 22 ? 'error' : npmVersion || pnpmVersion ? 'ok' : 'warn';
  const messageParts = [`Node.js v${process.versions.node}`];
  messageParts.push(npmVersion ? `npm ${npmVersion}` : 'npm missing');
  messageParts.push(pnpmVersion ? `pnpm ${pnpmVersion}` : 'pnpm missing');
  return [makeResult('runtime', 'Runtime', severity, messageParts.join(', '))];
}
