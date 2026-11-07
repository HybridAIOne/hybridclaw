#!/usr/bin/env node

import fs from 'node:fs';
import {
  checkNodeVersion,
  parseNodeRange,
} from '../container/shared/src/node-version.ts';

const checkOnly = process.argv.includes('--check');

const productPackageFiles = [
  'package.json',
  'console/package.json',
  'container/package.json',
  'desktop/package.json',
];

const rootLockPackageEntries = ['', 'console', 'container', 'desktop'];
const lockfiles = [
  {
    path: 'package-lock.json',
    packageEntries: rootLockPackageEntries,
    topLevel: true,
  },
  {
    path: 'npm-shrinkwrap.json',
    packageEntries: rootLockPackageEntries,
    topLevel: true,
  },
  {
    path: 'container/package-lock.json',
    packageEntries: [''],
    topLevel: true,
  },
  {
    path: 'container/npm-shrinkwrap.json',
    packageEntries: [''],
    topLevel: true,
  },
];

function fail(message) {
  console.error(`version-sync: ${message}`);
  process.exit(1);
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(`${filePath} is not valid JSON: ${message}`);
  }
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function setVersion(targets, object, filePath, fieldPath, version) {
  if (!object || typeof object !== 'object') {
    fail(`${filePath} ${fieldPath} is missing.`);
  }
  if (object.version === version) return;
  targets.push(
    `${filePath} ${fieldPath}: ${object.version ?? '<missing>'} -> ${version}`,
  );
  object.version = version;
}

const rootPackage = readJson('package.json');
const rootVersion = rootPackage.version;
if (typeof rootVersion !== 'string' || !rootVersion.trim()) {
  fail('package.json version must be a non-empty string.');
}

const changedFiles = new Set();
const changes = [];

for (const filePath of productPackageFiles) {
  const parsed = readJson(filePath);
  const before = JSON.stringify(parsed);
  setVersion(changes, parsed, filePath, 'version', rootVersion);
  if (JSON.stringify(parsed) !== before) {
    changedFiles.add(filePath);
    if (!checkOnly) writeJson(filePath, parsed);
  }
}

for (const lockfile of lockfiles) {
  const parsed = readJson(lockfile.path);
  const before = JSON.stringify(parsed);
  if (lockfile.topLevel) {
    setVersion(changes, parsed, lockfile.path, 'version', rootVersion);
  }
  for (const packageEntry of lockfile.packageEntries) {
    const entry = parsed.packages?.[packageEntry];
    const displayPath = packageEntry || '<root>';
    setVersion(
      changes,
      entry,
      lockfile.path,
      `packages[${JSON.stringify(displayPath)}].version`,
      rootVersion,
    );
  }
  if (JSON.stringify(parsed) !== before) {
    changedFiles.add(lockfile.path);
    if (!checkOnly) writeJson(lockfile.path, parsed);
  }
}

if (changes.length === 0) {
  console.log(
    `version-sync: product package versions are aligned at ${rootVersion}.`,
  );
} else if (checkOnly) {
  console.error('version-sync: product package versions are out of sync:');
  for (const change of changes) console.error(`  - ${change}`);
  process.exit(1);
} else {
  console.log(
    `version-sync: aligned ${changedFiles.size} file(s) to ${rootVersion}.`,
  );
}

// Node policy (owner call, 2026-10-24): engines.node is canonical. Generate
// standalone installer/manager pins and package copies. The security floor
// includes the CVE-2026-111497 Brotli fix; newer Node majors remain unsupported.
const nodeRange = rootPackage.engines.node;
const { minimum } = parseNodeRange(nodeRange);
const nodePackages = [
  ...productPackageFiles,
  'container/tools/package.json',
  'infra/managed-browser/package.json',
  ...fs
    .readdirSync('plugins')
    .map((name) => `plugins/${name}/package.json`)
    .filter((file) => fs.existsSync(file)),
];
function syncNodeFile(file, contents) {
  if (fs.readFileSync(file, 'utf8') === contents) return;
  if (checkOnly) {
    console.error(`version-sync: ${file} Node requirement is out of sync.`);
    process.exitCode = 1;
  } else {
    fs.writeFileSync(file, contents);
    console.log(`version-sync: aligned Node requirement in ${file}.`);
  }
}
for (const file of nodePackages) {
  const pkg = readJson(file);
  pkg.engines = { ...pkg.engines, node: nodeRange };
  syncNodeFile(file, `${JSON.stringify(pkg, null, 2)}\n`);
  const directory = file.slice(0, -'package.json'.length);
  for (const name of ['package-lock.json', 'npm-shrinkwrap.json']) {
    const lockPath = `${directory}${name}`;
    if (!fs.existsSync(lockPath)) continue;
    const lock = readJson(lockPath);
    const entries = directory === '' ? rootLockPackageEntries : [''];
    for (const entry of entries) {
      lock.packages[entry].engines = {
        ...lock.packages[entry].engines,
        node: nodeRange,
      };
    }
    syncNodeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  }
  const manifest = `${directory}hybridclaw.plugin.yaml`;
  if (fs.existsSync(manifest)) {
    syncNodeFile(
      manifest,
      fs
        .readFileSync(manifest, 'utf8')
        .replace(/^ {2}node:.*$/m, `  node: '${nodeRange}'`),
    );
  }
}
for (const file of ['.nvmrc', '.node-version'])
  syncNodeFile(file, `${minimum}\n`);
const installer = 'scripts/install.sh';
syncNodeFile(
  installer,
  fs
    .readFileSync(installer, 'utf8')
    .replace(
      /^REQUIRED_NODE_MINIMUM=.*$/m,
      `REQUIRED_NODE_MINIMUM="${minimum}"`,
    ),
);

// The gateway Dockerfile owns the shared immutable Node image reference.
const nodeImage = fs
  .readFileSync('Dockerfile', 'utf8')
  .match(/\b(node:(\d+\.\d+\.\d+)-slim@sha256:[a-f0-9]+)/);
if (!nodeImage || !checkNodeVersion(nodeImage[2], nodeRange).ok) {
  fail(
    'Dockerfile must pin a Node image within engines.node; update its tag and digest.',
  );
}
for (const file of [
  'container/Dockerfile',
  'infra/managed-browser/Dockerfile',
]) {
  syncNodeFile(
    file,
    fs
      .readFileSync(file, 'utf8')
      .replace(/^(FROM(?: --platform=\S+)?) node:\S+/gm, `$1 ${nodeImage[1]}`),
  );
}
