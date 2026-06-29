#!/usr/bin/env node

import fs from 'node:fs';

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
