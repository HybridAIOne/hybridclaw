import { readFileSync } from 'node:fs';

// Required major comes from package.json engines.node — the same source of
// truth src/node-version-guard.ts uses — so a future engines bump cannot
// leave this build/test gate demanding a stale major.
const pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);
const enginesNode = pkg.engines?.node ?? '';
const requiredMajor = Number.parseInt(/\d+/.exec(enginesNode)?.[0] ?? '', 10);
const actualMajor = Number(process.versions.node.split('.')[0]);

// process.exitCode (not process.exit) so the async stderr writes below are
// flushed even when piped.
if (!Number.isInteger(requiredMajor)) {
  console.error(
    `Could not determine the required Node.js major from engines.node ("${enginesNode}").`,
  );
  process.exitCode = 1;
} else if (actualMajor !== requiredMajor) {
  console.error(
    [
      `HybridClaw requires Node.js ${requiredMajor}.x, but this process is running ${process.version}.`,
      `Select Node ${requiredMajor} with your project Node manager before running repo commands.`,
      'The repo includes .nvmrc and .node-version pins for compatible managers.',
    ].join('\n'),
  );
  process.exitCode = 1;
}
