import { readFileSync } from 'node:fs';

// The required Node.js major is sourced from this package's own `engines.node`
// so there is a single source of truth. Imported first by the CLI entry, so
// this read and check happen before the heavier module graph loads and an
// unsupported runtime fails cleanly instead of crashing on a newer-Node API.

export interface NodeVersionCheck {
  ok: boolean;
  requiredMajor: number;
  actualMajor: number;
  message?: string;
}

export function parseRequiredMajor(enginesNode: string): number {
  const major = Number.parseInt(/\d+/.exec(enginesNode ?? '')?.[0] ?? '', 10);
  if (!Number.isInteger(major)) {
    throw new Error(
      `Could not determine the required Node.js major from engines.node ("${enginesNode}").`,
    );
  }
  return major;
}

function loadRequiredMajor(): number {
  const pkg = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { engines?: { node?: string } };
  return parseRequiredMajor(pkg.engines?.node ?? '');
}

export const REQUIRED_NODE_MAJOR = loadRequiredMajor();

export function checkNodeVersion(
  nodeVersion: string = process.versions.node,
  requiredMajor: number = REQUIRED_NODE_MAJOR,
): NodeVersionCheck {
  const parsedMajor = Number.parseInt(
    String(nodeVersion).replace(/^v/, '').split('.')[0] ?? '',
    10,
  );
  const actualMajor = Number.isNaN(parsedMajor) ? 0 : parsedMajor;
  if (actualMajor === requiredMajor) {
    return { ok: true, requiredMajor, actualMajor };
  }

  const message = [
    `hybridclaw requires Node.js ${requiredMajor}.x, but this process is running ${nodeVersion}.`,
    `Install Node.js ${requiredMajor} (the current LTS) and run the command again.`,
    `If you use a Node version manager (nvm, fnm, volta, asdf), switch to Node ${requiredMajor} first.`,
  ].join('\n');

  return { ok: false, requiredMajor, actualMajor, message };
}

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
