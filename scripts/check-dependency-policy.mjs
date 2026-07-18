#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const LOCKFILE_NAMES = new Set(['package-lock.json', 'npm-shrinkwrap.json']);
const LOCKFILE_BASELINE_PATH = 'scripts/dependency-policy-baseline.json';
const SHRINKWRAP_PAIRS = [
  ['package-lock.json', 'npm-shrinkwrap.json'],
  ['container/package-lock.json', 'container/npm-shrinkwrap.json'],
  [
    'plugins/whatsapp/package-lock.json',
    'plugins/whatsapp/npm-shrinkwrap.json',
  ],
];
const ALLOW_LOCKFILE_CHANGES = 'HYBRIDCLAW_ALLOW_LOCKFILE_CHANGES';
const ALLOW_LIFECYCLE_SCRIPTS = 'HYBRIDCLAW_ALLOW_DEPENDENCY_LIFECYCLE_SCRIPTS';

const args = new Set(process.argv.slice(2));
const checkStaged = args.has('--staged');
const baseRef = parseValueArg('--base');

function parseValueArg(name) {
  const rawArgs = process.argv.slice(2);
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (arg === name) return rawArgs[index + 1] || null;
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1) || null;
  }
  return null;
}

function fail(message) {
  console.error(`dependency-policy: ${message}`);
  process.exitCode = 1;
}

function runGit(gitArgs, options = {}) {
  return spawnSync('git', gitArgs, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
}

function gitOutput(gitArgs) {
  const result = runGit(gitArgs);
  if (result.status !== 0) return null;
  return result.stdout;
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function isIgnoredDir(name) {
  return (
    name === '.git' ||
    name === '.worktrees' ||
    name === 'coverage' ||
    name === 'dist' ||
    name === 'node_modules' ||
    name === 'release'
  );
}

function walkPackageJsons(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!isIgnoredDir(entry.name))
        walkPackageJsons(path.join(dir, entry.name), out);
      continue;
    }
    if (entry.isFile() && entry.name === 'package.json') {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

function listPackageJsons() {
  const output = gitOutput(['ls-files', '*package.json']);
  if (output != null) {
    return output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((filePath) => path.resolve(process.cwd(), filePath));
  }
  return walkPackageJsons(process.cwd());
}

function isPinnedExternalSpec(spec) {
  if (typeof spec !== 'string') return false;
  const trimmed = spec.trim();
  if (!trimmed) return false;
  if (
    trimmed.startsWith('file:') ||
    trimmed.startsWith('link:') ||
    trimmed.startsWith('workspace:')
  ) {
    return true;
  }
  if (
    /^https:\/\/npm\.jsr\.io\/~\/\d+\/@jsr\/[a-z0-9_-]+\/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\.tgz$/.test(
      trimmed,
    )
  ) {
    return true;
  }
  return (
    /^npm:[^@]+@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.test(trimmed) ||
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(trimmed)
  );
}

function checkPinnedDirectDependencies() {
  const dependencySections = [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
  ];
  const repoRoot = process.cwd();
  for (const packageJsonPath of listPackageJsons().sort()) {
    const relativePath = path.relative(repoRoot, packageJsonPath);
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    } catch (error) {
      fail(`${relativePath} is not valid JSON: ${error.message}`);
      continue;
    }
    for (const section of dependencySections) {
      const dependencies = parsed[section];
      if (!dependencies || typeof dependencies !== 'object') continue;
      for (const [name, spec] of Object.entries(dependencies).sort()) {
        if (isPinnedExternalSpec(spec)) continue;
        fail(
          `${relativePath} ${section}.${name} must be an exact version, pinned npm.jsr.io tarball, file:, link:, or workspace: spec (found ${JSON.stringify(spec)}).`,
        );
      }
    }
  }
}

function checkShrinkwrapsMatchLocks() {
  for (const [lockfile, shrinkwrap] of SHRINKWRAP_PAIRS) {
    if (!fs.existsSync(lockfile)) {
      fail(`missing ${lockfile}.`);
      continue;
    }
    if (!fs.existsSync(shrinkwrap)) {
      fail(`missing ${shrinkwrap}; run npm run deps:update-lockfile.`);
      continue;
    }
    if (
      fs.readFileSync(lockfile, 'utf8') !== fs.readFileSync(shrinkwrap, 'utf8')
    ) {
      fail(
        `${shrinkwrap} must match ${lockfile}; run npm run deps:update-lockfile.`,
      );
    }
  }
}

function lockfileChanged(filePath) {
  return LOCKFILE_NAMES.has(path.basename(filePath));
}

function stagedChangedFiles() {
  const output = gitOutput([
    'diff',
    '--cached',
    '--name-only',
    '--diff-filter=ACMRTD',
  ]);
  if (output == null) return [];
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function readJsonFromGit(ref, filePath) {
  const revspec = ref === ':' ? `:${filePath}` : `${ref}:${filePath}`;
  const output = gitOutput(['show', revspec]);
  if (output == null) return null;
  try {
    return JSON.parse(output);
  } catch {
    return null;
  }
}

function changedFilesFromBase(ref) {
  const output = gitOutput([
    'diff',
    '--name-only',
    '--diff-filter=ACMRTD',
    ref,
    'HEAD',
  ]);
  if (output == null) {
    fail(`could not compare dependency policy against base ref ${ref}.`);
    return [];
  }
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function hashFile(filePath) {
  return crypto
    .createHash('sha256')
    .update(fs.readFileSync(filePath))
    .digest('hex');
}

function readLockfileBaseline() {
  const parsed = readJsonFile(LOCKFILE_BASELINE_PATH);
  if (!parsed || typeof parsed !== 'object') return {};
  const lockfiles = parsed.lockfiles;
  return lockfiles && typeof lockfiles === 'object' ? lockfiles : {};
}

function isApprovedLockfile(filePath, baseline) {
  if (!fs.existsSync(filePath)) return false;
  return baseline[filePath] === hashFile(filePath);
}

function baseLockfileFor(filePath) {
  const pair = SHRINKWRAP_PAIRS.find(
    ([, shrinkwrap]) => shrinkwrap === filePath,
  );
  return pair ? pair[0] : filePath;
}

function packageEntriesWithLifecycleScripts(lockfile) {
  const result = new Map();
  const packages =
    lockfile && typeof lockfile === 'object' ? lockfile.packages : null;
  if (!packages || typeof packages !== 'object') return result;
  for (const [packagePath, entry] of Object.entries(packages)) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.hasInstallScript !== true) continue;
    const name = typeof entry.name === 'string' ? entry.name : packagePath;
    const version =
      typeof entry.version === 'string' ? entry.version : 'unknown';
    result.set(packagePath, `${name}@${version}`);
  }
  return result;
}

function checkChangedLockfilesAgainstBase(ref) {
  const changedLockfiles = changedFilesFromBase(ref)
    .filter(lockfileChanged)
    .sort();
  if (changedLockfiles.length === 0) return;

  const baseline = readLockfileBaseline();
  const unapprovedLockfiles = changedLockfiles.filter(
    (filePath) => !isApprovedLockfile(filePath, baseline),
  );
  if (
    unapprovedLockfiles.length > 0 &&
    process.env[ALLOW_LOCKFILE_CHANGES] !== '1'
  ) {
    fail(
      `lockfile changes are not approved in ${LOCKFILE_BASELINE_PATH}: ${unapprovedLockfiles.join(', ')}. Review dependency changes and update the lockfile baseline hashes.`,
    );
  }

  const newLifecyclePackages = [];
  for (const filePath of changedLockfiles) {
    if (isApprovedLockfile(filePath, baseline)) continue;
    const current = readJsonFile(filePath);
    if (!current) continue;
    const base = readJsonFromGit(ref, baseLockfileFor(filePath));
    const currentScripts = packageEntriesWithLifecycleScripts(current);
    const baseScripts = packageEntriesWithLifecycleScripts(base);
    for (const [packagePath, label] of currentScripts) {
      if (baseScripts.has(packagePath)) continue;
      newLifecyclePackages.push(
        `${filePath}:${packagePath || '<root>'} (${label})`,
      );
    }
  }

  if (
    newLifecyclePackages.length > 0 &&
    process.env[ALLOW_LIFECYCLE_SCRIPTS] !== '1'
  ) {
    fail(
      `new dependency lifecycle scripts require explicit review: ${newLifecyclePackages.join(', ')}. Update ${LOCKFILE_BASELINE_PATH} only after review.`,
    );
  }
}

function checkStagedLockfiles() {
  const changedLockfiles = stagedChangedFiles().filter(lockfileChanged).sort();
  if (changedLockfiles.length === 0) return;

  if (process.env[ALLOW_LOCKFILE_CHANGES] !== '1') {
    fail(
      `lockfile changes are blocked by default: ${changedLockfiles.join(', ')}. Set ${ALLOW_LOCKFILE_CHANGES}=1 after reviewing dependency changes.`,
    );
  }

  const newLifecyclePackages = [];
  for (const filePath of changedLockfiles) {
    const staged = readJsonFromGit(':', filePath);
    if (!staged) continue;
    const base = readJsonFromGit('HEAD', filePath);
    const stagedScripts = packageEntriesWithLifecycleScripts(staged);
    const baseScripts = packageEntriesWithLifecycleScripts(base);
    for (const [packagePath, label] of stagedScripts) {
      if (baseScripts.has(packagePath)) continue;
      newLifecyclePackages.push(
        `${filePath}:${packagePath || '<root>'} (${label})`,
      );
    }
  }

  if (
    newLifecyclePackages.length > 0 &&
    process.env[ALLOW_LIFECYCLE_SCRIPTS] !== '1'
  ) {
    fail(
      `new dependency lifecycle scripts require explicit review: ${newLifecyclePackages.join(', ')}. Set ${ALLOW_LIFECYCLE_SCRIPTS}=1 only after review.`,
    );
  }
}

checkPinnedDirectDependencies();
checkShrinkwrapsMatchLocks();
if (baseRef) checkChangedLockfilesAgainstBase(baseRef);
if (checkStaged) checkStagedLockfiles();
