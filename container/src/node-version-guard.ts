/**
 * Workers enforce their own package's Node requirement, including host mode.
 * Gateway startup checks do not establish the runtime of a separate worker.
 */
import { readFileSync } from 'node:fs';
import { checkNodeVersion } from '#shared/node-version.js';

const pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { engines: { node: string } };
const check = checkNodeVersion(process.versions.node, pkg.engines.node);
if (!check.ok) {
  console.error(check.message);
  process.exit(1);
}
