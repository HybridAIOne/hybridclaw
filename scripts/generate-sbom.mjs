#!/usr/bin/env node
// Generates Software Bills of Materials (SBOMs) for every distributed
// component into sbom/, in both CycloneDX and SPDX format, using `npm sbom`
// against the committed lockfiles (no node_modules required):
//
//   sbom/<component>.cdx.json   CycloneDX 1.5
//   sbom/<component>.spdx.json  SPDX 2.3
//
// Components are discovered by walking the repo for package-lock.json files
// (same rules as check-dependency-policy). Dev-only dependencies are omitted;
// they are not distributed.
//
// The release workflow runs this and attaches sbom/ to the release artifacts;
// run `npm run sbom` locally to produce the same files for audits.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const OUTPUT_DIR = 'sbom';

function fail(message) {
  console.error(`sbom: ${message}`);
  process.exit(1);
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

const componentDirs = findLockfileDirs('.').sort();
if (componentDirs.length === 0) fail('no package-lock.json files found.');

fs.rmSync(OUTPUT_DIR, { recursive: true, force: true });
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-sbom-'));
try {
  for (const dir of componentDirs) {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(dir, 'package.json'), 'utf8'),
    );
    const baseName = manifest.name.replace(/^@/, '').replace(/\//g, '-');
    // npm resolves workspace members (e.g. container/) up to the repo root and
    // names the SBOM subject after the directory, so stage each component's
    // manifest and lockfile in an isolated, name-stable temp directory.
    const stageDir = path.join(tmpRoot, baseName);
    fs.mkdirSync(stageDir, { recursive: true });
    fs.copyFileSync(
      path.join(dir, 'package.json'),
      path.join(stageDir, 'package.json'),
    );
    const lockfile = fs.existsSync(path.join(dir, 'npm-shrinkwrap.json'))
      ? 'npm-shrinkwrap.json'
      : 'package-lock.json';
    fs.copyFileSync(path.join(dir, lockfile), path.join(stageDir, lockfile));

    for (const [format, suffix] of [
      ['cyclonedx', 'cdx.json'],
      ['spdx', 'spdx.json'],
    ]) {
      const result = spawnSync(
        'npm',
        [
          'sbom',
          '--sbom-format',
          format,
          '--sbom-type',
          'application',
          '--omit',
          'dev',
          '--package-lock-only',
        ],
        { cwd: stageDir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
      );
      if (result.status !== 0) {
        fail(`npm sbom failed for ${dir} (${format}):\n${result.stderr}`);
      }
      const outputPath = path.join(OUTPUT_DIR, `${baseName}.${suffix}`);
      fs.writeFileSync(outputPath, result.stdout);
      console.log(`sbom: wrote ${outputPath}`);
    }
  }
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}
