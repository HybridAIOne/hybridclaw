import { readFileSync } from 'node:fs';

const pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);
let checker;
try {
  checker = await import('../container/shared/src/node-version.ts');
} catch {
  // Node without type stripping cannot load the checker and is unsupported.
}
const check = checker
  ? checker.checkNodeVersion(process.versions.node, pkg.engines.node)
  : {
      ok: false,
      message: `HybridClaw requires Node.js ${pkg.engines.node}; found ${process.versions.node}.`,
    };
// Let pending stderr writes flush before exiting repository commands.
if (!check.ok) {
  console.error(check.message);
  process.exitCode = 1;
}
