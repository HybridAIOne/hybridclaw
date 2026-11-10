import { readFileSync } from 'node:fs';

const pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);
let check;
try {
  // Loaded dynamically: a Node without native type stripping (before 22.18)
  // cannot import the .ts module, and that is exactly the runtime to reject.
  const { checkNodeVersion } = await import(
    '../packages/shared/src/node-version.ts'
  );
  check = checkNodeVersion(process.versions.node, pkg.engines.node);
} catch {
  check = {
    ok: false,
    message: `HybridClaw requires Node.js ${pkg.engines.node}, but this process is running v${process.versions.node}.`,
  };
}
// Let pending stderr writes flush before exiting repository commands.
if (!check.ok) {
  console.error(check.message);
  process.exitCode = 1;
}
