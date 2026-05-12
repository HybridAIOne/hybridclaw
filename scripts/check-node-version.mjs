const requiredMajor = 22;
const actual = process.versions.node;
const actualMajor = Number(actual.split('.')[0]);

if (actualMajor !== requiredMajor) {
  console.error(
    [
      `HybridClaw requires Node.js ${requiredMajor}.x, but this process is running ${process.version}.`,
      'Select Node 22 with your project Node manager before running repo commands.',
      'The repo includes .nvmrc and .node-version pins for compatible managers.',
    ].join('\n'),
  );
  process.exit(1);
}
