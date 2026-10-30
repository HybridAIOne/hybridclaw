/**
 * Runtime diagnostics use the package's engines range without exiting on import.
 * The CLI bootstrap guard owns termination; doctor can report an invalid runtime.
 */
import { readFileSync } from 'node:fs';
import { checkNodeVersion as checkVersion } from '#shared/node-version.js';

const pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { engines: { node: string } };

export const REQUIRED_NODE_RANGE = pkg.engines.node;

export function checkNodeVersion(nodeVersion = process.versions.node) {
  return checkVersion(nodeVersion, REQUIRED_NODE_RANGE);
}
