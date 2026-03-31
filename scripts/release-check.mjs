#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

const requiredExactPaths = [
  'package.json',
  'README.md',
  'LICENSE',
  'dist/cli.js',
  'console/dist/index.html',
  'scripts/postinstall-container.mjs',
];

const requiredPrefixes = [
  'dist/',
  'skills/',
  'templates/',
  'docs/',
  'container/src/',
  'console/dist/',
  'container/shared/',
];

const forbiddenPathPatterns = [
  /^src\//,
  /^tests\//,
  /^\.github\//,
  /^scripts\//,
  /^vitest\..*\.ts$/,
  /^biome\.json$/,
  /^tsconfig\.json$/,
  /^dist\/.*\.test\./,
  /\.test\.(ts|tsx|js|mjs|cjs|d\.ts)(\.map)?$/,
];

function fail(message) {
  console.error(`release-check: ${message}`);
  process.exit(1);
}

function runPackDryJson() {
  const command = spawnSync(
    'npm',
    ['pack', '--silent', '--dry-run', '--json', '--ignore-scripts'],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        NPM_CONFIG_CACHE:
          process.env.NPM_CONFIG_CACHE || '/tmp/hybridclaw-npm-cache',
      },
    },
  );

  if (command.status !== 0) {
    const details = command.stderr?.trim() || command.stdout?.trim();
    fail(`npm pack --dry-run failed${details ? `\n${details}` : ''}`);
  }

  const raw = `${command.stdout || ''}${command.stderr || ''}`;
  const jsonStart = raw.indexOf('[');
  const jsonEnd = raw.lastIndexOf(']');
  if (jsonStart < 0) {
    fail('could not find JSON output from npm pack --dry-run.');
  }
  if (jsonEnd < jsonStart) {
    fail('could not determine JSON bounds from npm pack --dry-run output.');
  }

  let parsed;
  try {
    parsed = JSON.parse(raw.slice(jsonStart, jsonEnd + 1));
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    fail(`failed to parse npm pack JSON: ${msg}`);
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    fail('npm pack --dry-run returned an empty result.');
  }
  return parsed[0];
}

function main() {
  const result = runPackDryJson();
  const files = Array.isArray(result.files) ? result.files : [];
  const paths = files
    .map((entry) => (entry && typeof entry.path === 'string' ? entry.path : ''))
    .filter(Boolean);
  const pathSet = new Set(paths);

  const missingExact = requiredExactPaths.filter((path) => !pathSet.has(path));
  const missingPrefixes = requiredPrefixes.filter(
    (prefix) => !paths.some((path) => path.startsWith(prefix)),
  );
  const forbidden = paths
    .filter(
      (path) =>
        path !== 'scripts/postinstall-container.mjs' &&
        forbiddenPathPatterns.some((pattern) => pattern.test(path)),
    )
    .sort();

  if (
    missingExact.length > 0 ||
    missingPrefixes.length > 0 ||
    forbidden.length > 0
  ) {
    if (missingExact.length > 0) {
      console.error('release-check: missing required files:');
      for (const path of missingExact) console.error(`  - ${path}`);
    }

    if (missingPrefixes.length > 0) {
      console.error('release-check: missing required file groups:');
      for (const prefix of missingPrefixes) console.error(`  - ${prefix}*`);
    }

    if (forbidden.length > 0) {
      console.error('release-check: forbidden files found in npm pack:');
      for (const path of forbidden) console.error(`  - ${path}`);
    }

    process.exit(1);
  }

  console.log(
    `release-check: npm pack contents look OK (${result.entryCount ?? paths.length} files).`,
  );
}

main();
