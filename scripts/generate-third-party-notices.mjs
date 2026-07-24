#!/usr/bin/env node

// Generates THIRD_PARTY_NOTICES.md from the committed lockfiles and the
// installed node_modules trees:
//
// 1. Discovers core distributed components by walking the repo for
//    package-lock.json files (same ignore rules as check-dependency-policy),
//    excluding install-on-demand plugins unless selected with --component;
//    the adjacent npm-shrinkwrap.json is preferred when present.
// 2. Inventories every production dependency (lockfile entries flagged
//    `dev: true` are excluded; dev-only tooling is not distributed).
// 3. Embeds the license text bundled with each installed package, deduplicated
//    by content, plus every NOTICE file (Apache License 2.0 Section 4(d)
//    requires NOTICE propagation).
//
// Platform-specific optional dependencies (`optional: true`) are listed in the
// inventory from lockfile metadata only; their trees are not read so the
// output is identical on every platform.
//
// Usage:
//   node scripts/generate-third-party-notices.mjs          # (re)write the file
//   node scripts/generate-third-party-notices.mjs --check  # fail if stale
//   npm run notices:whatsapp-plugin                         # plugin-only file
//
// Requires production node_modules for every selected component:
//   npm run deps:verify && npm --prefix plugins/brevo-email ci --ignore-scripts

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const checkMode = process.argv.includes('--check');
const componentArg = process.argv
  .find((arg) => arg.startsWith('--component='))
  ?.slice('--component='.length);
const outputArg = process.argv
  .find((arg) => arg.startsWith('--output='))
  ?.slice('--output='.length);
const OUTPUT_PATH = outputArg || 'THIRD_PARTY_NOTICES.md';
const CORE_EXCLUDED_COMPONENTS = new Set(['plugins/whatsapp']);

function fail(message) {
  console.error(`third-party-notices: ${message}`);
  process.exit(1);
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

function findLockfileDirs(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!isIgnoredDir(entry.name))
        findLockfileDirs(path.join(dir, entry.name), out);
      continue;
    }
    if (entry.isFile() && entry.name === 'package-lock.json') out.push(dir);
  }
  return out;
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function licenseExpression(license) {
  if (typeof license === 'string') return license;
  if (
    license &&
    typeof license === 'object' &&
    typeof license.type === 'string'
  )
    return license.type;
  return 'UNKNOWN';
}

function packageNameFromKey(key) {
  const marker = 'node_modules/';
  const index = key.lastIndexOf(marker);
  return key.slice(index + marker.length);
}

const LICENSE_FILE_PATTERN = /^(licen[cs]e|copying)([.\-_]|$)/i;
const NOTICE_FILE_PATTERN = /^notice([.\-_]|$)/i;

function readTextFiles(dir, pattern) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null; // package not installed
  }
  const texts = [];
  for (const entry of entries) {
    if (!entry.isFile() || !pattern.test(entry.name)) continue;
    const text = fs
      .readFileSync(path.join(dir, entry.name), 'utf8')
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((line) => line.trimEnd())
      .join('\n')
      .trim();
    if (text) texts.push({ file: entry.name, text });
  }
  texts.sort((a, b) => a.file.localeCompare(b.file));
  return texts;
}

// --- Collect components and dependencies -----------------------------------

const componentDirs = findLockfileDirs('.')
  .filter((dir) =>
    componentArg
      ? path.normalize(dir) === path.normalize(componentArg)
      : !CORE_EXCLUDED_COMPONENTS.has(path.normalize(dir)),
  )
  .sort();
if (componentDirs.length === 0) fail('no package-lock.json files found.');

const components = [];
// key `${name}@${version}` -> { name, version, license, dir | null (optional) }
const uniquePackages = new Map();
const missingInstalls = [];

for (const dir of componentDirs) {
  const manifest = readJson(path.join(dir, 'package.json'));
  const lockfilePath = fs.existsSync(path.join(dir, 'npm-shrinkwrap.json'))
    ? path.join(dir, 'npm-shrinkwrap.json')
    : path.join(dir, 'package-lock.json');
  const lockfile = readJson(lockfilePath);
  if (!manifest || !lockfile) fail(`could not parse manifests in ${dir}.`);

  const rows = [];
  for (const [key, entry] of Object.entries(lockfile.packages || {})) {
    if (!key.includes('node_modules/')) continue; // root + workspace dirs
    if (entry.link === true || entry.dev === true) continue;
    const name = entry.name || packageNameFromKey(key);
    const version = entry.version || 'unknown';
    const license = licenseExpression(entry.license);
    const id = `${name}@${version}`;
    rows.push({ name, version, license });
    const existing = uniquePackages.get(id);
    const installedDir = entry.optional === true ? null : path.join(dir, key);
    if (!existing) {
      uniquePackages.set(id, { name, version, license, dir: installedDir });
    } else if (existing.dir === null && installedDir !== null) {
      existing.dir = installedDir;
    }
  }

  const seen = new Set();
  const deduped = rows
    .filter((row) => {
      const id = `${row.name}@${row.version}`;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .sort(
      (a, b) =>
        a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
    );

  components.push({
    dir,
    name: manifest.name || dir,
    lockfilePath,
    rows: deduped,
  });
}

// --- Read bundled license and NOTICE texts ---------------------------------

// content hash -> { text, packages: [id] }
const licenseTexts = new Map();
const noticeFiles = []; // { id, file, text }
const withoutText = []; // { name, version, license, reason }

const sortedPackages = [...uniquePackages.values()].sort(
  (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
);

for (const pkg of sortedPackages) {
  const id = `${pkg.name}@${pkg.version}`;
  if (pkg.dir === null) {
    withoutText.push({
      ...pkg,
      reason: 'platform-specific optional dependency',
    });
    continue;
  }
  const texts = readTextFiles(pkg.dir, LICENSE_FILE_PATTERN);
  if (texts === null) {
    missingInstalls.push(id);
    continue;
  }
  if (pkg.license === 'UNKNOWN') {
    // Lockfiles omit license metadata for some registries (e.g. JSR tarballs);
    // fall back to the installed manifest.
    const manifest = readJson(path.join(pkg.dir, 'package.json'));
    const legacy = Array.isArray(manifest?.licenses)
      ? manifest.licenses.map((l) => licenseExpression(l)).join(' OR ')
      : null;
    pkg.license = licenseExpression(manifest?.license ?? legacy);
  }
  const notices = readTextFiles(pkg.dir, NOTICE_FILE_PATTERN) || [];
  for (const notice of notices) noticeFiles.push({ id, ...notice });
  if (texts.length === 0) {
    withoutText.push({
      ...pkg,
      reason: 'no license file bundled with the package',
    });
    continue;
  }
  const combined = texts.map((t) => t.text).join('\n\n---\n\n');
  const hash = crypto.createHash('sha256').update(combined).digest('hex');
  const bucket = licenseTexts.get(hash);
  if (bucket) bucket.packages.push(id);
  else
    licenseTexts.set(hash, {
      text: combined,
      license: pkg.license,
      packages: [id],
    });
}

if (missingInstalls.length > 0) {
  const installCommand = componentArg
    ? '  npm run setup:whatsapp-plugin'
    : '  npm run deps:verify && npm --prefix plugins/brevo-email ci --ignore-scripts';
  fail(
    `node_modules missing for ${missingInstalls.length} package(s) (e.g. ${missingInstalls
      .slice(0, 5)
      .join(
        ', ',
      )}). Install production dependencies for every component first:\n` +
      installCommand,
  );
}

// --- Render ----------------------------------------------------------------

const FENCE = '````';
const lines = [];
lines.push('# Third-Party Notices');
lines.push('');
lines.push(
  'HybridClaw is licensed under the MIT License (see [LICENSE](./LICENSE)).',
  'This file lists the third-party packages distributed with or depended upon',
  'by HybridClaw components, together with their license texts and NOTICE',
  'files as required by the respective licenses (including Apache License 2.0,',
  'Section 4(d)).',
);
lines.push('');
const regenerateCommand = componentArg
  ? 'npm run notices:whatsapp-plugin'
  : 'npm run notices';
lines.push(
  'This file is generated from the committed lockfiles by',
  `\`scripts/generate-third-party-notices.mjs\`; regenerate with \`${regenerateCommand}\`.`,
  componentArg
    ? `Scope: production dependencies of \`${componentArg}\`.`
    : 'Scope: production dependencies of core distributed components; the opt-in WhatsApp plugin carries a separate notice file.',
  'Dev-only tooling is not distributed and therefore not listed. Platform-specific',
  'optional dependencies are inventoried from lockfile metadata; their license',
  'texts ship inside the respective packages.',
);
lines.push('');

for (const component of components) {
  lines.push(`## ${component.name} (\`${component.lockfilePath}\`)`);
  lines.push('');
  lines.push(`${component.rows.length} production dependencies.`);
  lines.push('');
  lines.push('| Package | Version | License |');
  lines.push('| --- | --- | --- |');
  for (const row of component.rows) {
    // Licenses may have been refined from the installed manifest above.
    const license =
      uniquePackages.get(`${row.name}@${row.version}`)?.license ?? row.license;
    lines.push(`| ${row.name} | ${row.version} | ${license} |`);
  }
  lines.push('');
}

lines.push('## NOTICE Files');
lines.push('');
if (noticeFiles.length === 0) {
  lines.push('No dependency ships a NOTICE file.');
  lines.push('');
} else {
  for (const notice of noticeFiles) {
    lines.push(`### ${notice.id} — ${notice.file}`);
    lines.push('');
    lines.push(`${FENCE}text`);
    lines.push(notice.text);
    lines.push(FENCE);
    lines.push('');
  }
}

lines.push('## License Texts');
lines.push('');
const buckets = [...licenseTexts.values()].sort((a, b) =>
  a.packages[0].localeCompare(b.packages[0]),
);
buckets.forEach((bucket, index) => {
  lines.push(`### Text ${index + 1} of ${buckets.length}`);
  lines.push('');
  lines.push(`Applies to: ${bucket.packages.join(', ')}`);
  lines.push('');
  lines.push(`${FENCE}text`);
  lines.push(bucket.text);
  lines.push(FENCE);
  lines.push('');
});

if (withoutText.length > 0) {
  lines.push('## Packages Without An Embedded License Text');
  lines.push('');
  lines.push(
    'Licensed under the SPDX identifier below; the license text ships inside',
    'the package itself or is available at <https://spdx.org/licenses/>.',
  );
  lines.push('');
  lines.push('| Package | Version | License | Reason |');
  lines.push('| --- | --- | --- | --- |');
  for (const pkg of withoutText) {
    lines.push(
      `| ${pkg.name} | ${pkg.version} | ${pkg.license} | ${pkg.reason} |`,
    );
  }
  lines.push('');
}

const content = `${lines.join('\n').trimEnd()}\n`;

if (checkMode) {
  const existing = fs.existsSync(OUTPUT_PATH)
    ? fs.readFileSync(OUTPUT_PATH, 'utf8')
    : null;
  if (existing !== content) {
    fail(`${OUTPUT_PATH} is stale. Regenerate it with: npm run notices`);
  }
  console.log(`third-party-notices: ${OUTPUT_PATH} is up to date.`);
} else {
  fs.writeFileSync(OUTPUT_PATH, content);
  console.log(
    `third-party-notices: wrote ${OUTPUT_PATH} (${components.length} components, ` +
      `${uniquePackages.size} packages, ${buckets.length} unique license texts, ` +
      `${noticeFiles.length} NOTICE files).`,
  );
}
