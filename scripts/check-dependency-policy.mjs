#!/usr/bin/env node

// Dependency policy gate. Entry points: `npm run deps:policy`, the Husky
// pre-commit hook (`--staged`), the CI lint job on pull requests
// (`--base <sha>`), and `npm run release:check`.
//
// Enforced checks:
// 1. Direct dependencies in tracked package.json files must be exact pins
//    (or file:/link:/workspace:/pinned npm.jsr.io tarball specs).
// 2. Each npm-shrinkwrap.json must byte-match its package-lock.json pair.
// 3. Lockfile changes must be approved via the SHA-256 hashes under
//    "lockfiles" in scripts/dependency-policy-baseline.json. A deletion is
//    approved by removing its baseline entry. New dependency lifecycle
//    scripts require explicit review.
// 4. License gate over every tracked package-lock.json (shrinkwraps are
//    covered by check 2), read from the lockfile `license` metadata:
//    - Forbidden (fails): strong copyleft and source-restricted families —
//      GPL, AGPL, SSPL. A package is only accepted when the "licenses"
//      section of scripts/dependency-policy-baseline.json contains its exact
//      "<name>@<version>": "<license>" pair, added after license review.
//      Stale or mismatched baseline entries fail so the exception list stays
//      honest.
//    - Reported but allowed: weak/file-level copyleft (LGPL, MPL, EPL, EUPL,
//      CDDL, OSL, CPAL), source-available/non-commercial (BUSL, CC-BY-NC),
//      and packages with missing or unparseable license metadata (review
//      those manually).
//    - SPDX expressions: `OR` resolves to the most permissive branch, so
//      dual-licensed packages such as jszip "(MIT OR GPL-3.0-or-later)"
//      count as MIT and pass. `AND` resolves to the most restrictive part,
//      and `WITH <exception>` is classified by its base license id.
//
// Escape hatches for local work in progress (CI never sets them):
// HYBRIDCLAW_ALLOW_LOCKFILE_CHANGES=1,
// HYBRIDCLAW_ALLOW_DEPENDENCY_LIFECYCLE_SCRIPTS=1, and
// HYBRIDCLAW_ALLOW_LICENSE_VIOLATIONS=1 (license failures become warnings).

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const LOCKFILE_NAMES = new Set(['package-lock.json', 'npm-shrinkwrap.json']);
const LOCKFILE_BASELINE_PATH = 'scripts/dependency-policy-baseline.json';
const SHRINKWRAP_PAIRS = [
  ['package-lock.json', 'npm-shrinkwrap.json'],
  ['container/package-lock.json', 'container/npm-shrinkwrap.json'],
];
const ALLOW_LOCKFILE_CHANGES = 'HYBRIDCLAW_ALLOW_LOCKFILE_CHANGES';
const ALLOW_LIFECYCLE_SCRIPTS = 'HYBRIDCLAW_ALLOW_DEPENDENCY_LIFECYCLE_SCRIPTS';
const ALLOW_LICENSE_VIOLATIONS = 'HYBRIDCLAW_ALLOW_LICENSE_VIOLATIONS';

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

function report(message) {
  console.warn(`dependency-policy: ${message}`);
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
    // All dot-directories: .git, and the git worktrees under .claude/worktrees/
    // (and legacy .worktrees/) contain full repo checkouts with their own
    // lockfiles that must not be scanned.
    name.startsWith('.') ||
    name === 'coverage' ||
    name === 'dist' ||
    name === 'node_modules' ||
    name === 'release'
  );
}

function walkFilesNamed(dir, fileName, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!isIgnoredDir(entry.name))
        walkFilesNamed(path.join(dir, entry.name), fileName, out);
      continue;
    }
    if (entry.isFile() && entry.name === fileName) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

function listTrackedFilesNamed(fileName) {
  const output = gitOutput(['ls-files', `*${fileName}`]);
  if (output != null) {
    return output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((filePath) => path.resolve(process.cwd(), filePath));
  }
  return walkFilesNamed(process.cwd(), fileName);
}

function listPackageJsons() {
  return listTrackedFilesNamed('package.json');
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

const LICENSE_ALLOWED = 0;
const LICENSE_REPORTED = 1;
const LICENSE_FORBIDDEN = 2;

function licenseIdSeverity(id) {
  const normalized = id.toUpperCase();
  if (normalized.startsWith('LGPL')) return LICENSE_REPORTED;
  if (/^(AGPL|GPL|SSPL)/.test(normalized)) return LICENSE_FORBIDDEN;
  if (/^(MPL|EPL|EUPL|CDDL|OSL|CPAL|BUSL|CC-BY-NC|UNLICENSED)/.test(normalized))
    return LICENSE_REPORTED;
  return LICENSE_ALLOWED;
}

function parseSpdxSeverity(expression) {
  const tokens = expression
    .replace(/([()])/g, ' $1 ')
    .split(/\s+/)
    .filter(Boolean);
  let index = 0;

  function parseUnit() {
    const token = tokens[index++];
    if (token === '(') {
      const severity = parseOr();
      if (tokens[index++] !== ')') throw new Error('expected )');
      return severity;
    }
    if (token === undefined || token === ')' || /^(AND|OR|WITH)$/i.test(token))
      throw new Error(`unexpected token ${token}`);
    const severity = licenseIdSeverity(token);
    if (index < tokens.length && /^WITH$/i.test(tokens[index])) {
      index += 1;
      const exception = tokens[index++];
      if (exception === undefined || exception === '(' || exception === ')')
        throw new Error('expected license exception id');
    }
    return severity;
  }

  function parseAnd() {
    let severity = parseUnit();
    while (index < tokens.length && /^AND$/i.test(tokens[index])) {
      index += 1;
      severity = Math.max(severity, parseUnit());
    }
    return severity;
  }

  function parseOr() {
    let severity = parseAnd();
    while (index < tokens.length && /^OR$/i.test(tokens[index])) {
      index += 1;
      severity = Math.min(severity, parseAnd());
    }
    return severity;
  }

  const severity = parseOr();
  if (index !== tokens.length) throw new Error('trailing tokens');
  return severity;
}

function classifyLicense(license) {
  const raw =
    typeof license === 'string'
      ? license
      : license &&
          typeof license === 'object' &&
          typeof license.type === 'string'
        ? license.type
        : '';
  const expression = raw.trim();
  if (!expression)
    return { severity: LICENSE_REPORTED, unknown: true, expression: null };
  try {
    return {
      severity: parseSpdxSeverity(expression),
      unknown: false,
      expression,
    };
  } catch {
    return { severity: LICENSE_REPORTED, unknown: true, expression };
  }
}

function lockfileLicenseEntries(lockfile) {
  const entries = new Map();
  const packages =
    lockfile && typeof lockfile === 'object' ? lockfile.packages : null;
  if (!packages || typeof packages !== 'object') return entries;
  for (const [packagePath, entry] of Object.entries(packages)) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.link === true) continue;
    const marker = packagePath.lastIndexOf('node_modules/');
    if (marker === -1) continue;
    const name =
      typeof entry.name === 'string' && entry.name
        ? entry.name
        : packagePath.slice(marker + 'node_modules/'.length);
    const version =
      typeof entry.version === 'string' ? entry.version : 'unknown';
    const key = `${name}@${version}`;
    if (!entries.has(key)) entries.set(key, entry.license);
  }
  return entries;
}

function readLicenseBaseline() {
  const parsed = readJsonFile(LOCKFILE_BASELINE_PATH);
  if (!parsed || typeof parsed !== 'object') return {};
  const licenses = parsed.licenses;
  return licenses && typeof licenses === 'object' ? licenses : {};
}

function listPackageLocks() {
  const repoRoot = process.cwd();
  return listTrackedFilesNamed('package-lock.json')
    .map((filePath) => path.relative(repoRoot, filePath))
    .sort();
}

function checkLicenses() {
  const baseline = readLicenseBaseline();
  const usedBaselineKeys = new Set();
  const failLicense =
    process.env[ALLOW_LICENSE_VIOLATIONS] === '1'
      ? (message) =>
          report(`${ALLOW_LICENSE_VIOLATIONS}=1 override: ${message}`)
      : fail;

  for (const lockfilePath of listPackageLocks()) {
    const lockfile = readJsonFile(lockfilePath);
    if (!lockfile) {
      failLicense(`${lockfilePath} could not be parsed for the license scan.`);
      continue;
    }
    const baselined = [];
    const reported = new Map();
    const unknown = [];
    const entries = [...lockfileLicenseEntries(lockfile)].sort(([a], [b]) =>
      a.localeCompare(b),
    );
    for (const [key, license] of entries) {
      const {
        severity,
        unknown: isUnknown,
        expression,
      } = classifyLicense(license);
      if (severity === LICENSE_FORBIDDEN) {
        if (Object.hasOwn(baseline, key) && baseline[key] === expression) {
          usedBaselineKeys.add(key);
          baselined.push(`${key} (${expression})`);
        } else if (Object.hasOwn(baseline, key)) {
          usedBaselineKeys.add(key);
          failLicense(
            `${lockfilePath}: ${key} license ${JSON.stringify(expression)} does not match its "licenses" baseline entry ${JSON.stringify(baseline[key])} in ${LOCKFILE_BASELINE_PATH}; re-review the package and update the entry.`,
          );
        } else {
          failLicense(
            `${lockfilePath}: ${key} has forbidden license ${JSON.stringify(expression)} (GPL/AGPL/SSPL family). Remove the dependency or, after license review, add ${JSON.stringify(key)}: ${JSON.stringify(expression)} to "licenses" in ${LOCKFILE_BASELINE_PATH}.`,
          );
        }
        continue;
      }
      if (isUnknown) {
        unknown.push(
          expression ? `${key} (${JSON.stringify(expression)})` : key,
        );
      } else if (severity === LICENSE_REPORTED) {
        if (!reported.has(expression)) reported.set(expression, []);
        reported.get(expression).push(key);
      }
    }
    if (baselined.length > 0)
      report(
        `${lockfilePath}: baselined copyleft exceptions: ${baselined.join(', ')}.`,
      );
    for (const [expression, keys] of [...reported].sort(([a], [b]) =>
      a.localeCompare(b),
    ))
      report(
        `${lockfilePath}: ${expression} (allowed, reported): ${keys.join(', ')}.`,
      );
    if (unknown.length > 0)
      report(
        `${lockfilePath}: unknown license metadata (review manually): ${unknown.join(', ')}.`,
      );
  }

  for (const key of Object.keys(baseline).sort()) {
    if (usedBaselineKeys.has(key)) continue;
    failLicense(
      `stale "licenses" baseline entry ${key} matches no lockfile package; remove it from ${LOCKFILE_BASELINE_PATH}.`,
    );
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
  if (!fs.existsSync(filePath)) return baseline[filePath] === undefined;
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
checkLicenses();
if (baseRef) checkChangedLockfilesAgainstBase(baseRef);
if (checkStaged) checkStagedLockfiles();
