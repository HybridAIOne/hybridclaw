import { readFileSync } from 'node:fs';
import { checkNodeVersion } from '../container/shared/node-version.js';

const pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);
const check = checkNodeVersion(process.versions.node, pkg.engines.node);
// Let pending stderr writes flush before exiting repository commands.
if (!check.ok) {
  console.error(check.message);
  process.exitCode = 1;
}
