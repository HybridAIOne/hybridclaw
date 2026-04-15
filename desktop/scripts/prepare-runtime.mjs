import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const currentFile = fileURLToPath(import.meta.url);
const scriptsDir = path.dirname(currentFile);
const desktopDir = path.resolve(scriptsDir, '..');
const repoRoot = path.resolve(desktopDir, '..');
const runtimeBinDir = path.join(desktopDir, 'build', 'runtime-bin');
const runtimeDepsDir = path.join(desktopDir, 'build', 'runtime-deps');
const rootNodeModulesSource = path.join(repoRoot, 'node_modules');
const rootNodeModulesTarget = path.join(runtimeDepsDir, 'root-node_modules');
const containerNodeModulesSource = path.join(repoRoot, 'container', 'node_modules');
const containerNodeModulesTarget = path.join(
  runtimeDepsDir,
  'container-node_modules',
);
const bundledNodePath = path.join(runtimeBinDir, 'node');

function readDependencyTree(cwd) {
  const result = spawnSync(
    'npm',
    ['ls', '--omit=dev', '--all', '--json', '--long'],
    {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        npm_config_loglevel: 'silent',
      },
      maxBuffer: 64 * 1024 * 1024,
    },
  );

  if (!result.stdout.trim()) {
    throw new Error(
      result.stderr.trim() ||
        `Unable to resolve runtime dependencies for ${cwd}.`,
    );
  }

  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(
      error instanceof Error
        ? `Unable to parse npm dependency tree for ${cwd}: ${error.message}`
        : `Unable to parse npm dependency tree for ${cwd}.`,
    );
  }
}

function collectDependencyPaths(
  tree,
  sourceRoot,
  collected = new Set(),
  rootDependencyNames = null,
) {
  if (
    tree &&
    typeof tree === 'object' &&
    typeof tree.path === 'string' &&
    tree.path.startsWith(`${sourceRoot}${path.sep}`) &&
    tree.extraneous !== true
  ) {
    collected.add(tree.path);
  }

  if (!tree?.dependencies || typeof tree.dependencies !== 'object') {
    return collected;
  }

  const entries =
    rootDependencyNames === null
      ? Object.values(tree.dependencies)
      : rootDependencyNames
          .map((name) => tree.dependencies[name])
          .filter(Boolean);

  for (const dependency of entries) {
    collectDependencyPaths(dependency, sourceRoot, collected, null);
  }

  return collected;
}

function collapseDependencyPaths(paths) {
  return [...paths]
    .sort((left, right) => left.length - right.length)
    .filter(
      (candidate, index, sorted) =>
        !sorted
          .slice(0, index)
          .some((parent) => candidate.startsWith(`${parent}${path.sep}`)),
    );
}

function matchesConstraint(values, current) {
  if (!Array.isArray(values) || values.length === 0) return true;

  const negatives = values
    .filter((value) => typeof value === 'string' && value.startsWith('!'))
    .map((value) => value.slice(1));
  if (negatives.includes(current)) return false;

  const positives = values.filter(
    (value) => typeof value === 'string' && !value.startsWith('!'),
  );
  return positives.length === 0 || positives.includes(current);
}

async function shouldIncludePackage(packagePath) {
  const packageJsonPath = path.join(packagePath, 'package.json');

  try {
    const raw = await fs.readFile(packageJsonPath, 'utf8');
    const parsed = JSON.parse(raw);
    return (
      matchesConstraint(parsed.os, process.platform) &&
      matchesConstraint(parsed.cpu, process.arch)
    );
  } catch {
    return true;
  }
}

/** Packages excluded from the runtime bundle (browser-only / unused). */
const EXCLUDED_PACKAGES = new Set([
  'onnxruntime-web',
]);

/**
 * Directory basenames stripped from every copied package to shed test fixtures
 * and other files that aren't needed at runtime.
 */
const STRIPPED_DIRS = new Set([
  'test',
  'tests',
  '__tests__',
]);

function shouldCopyEntry(src) {
  const base = path.basename(src);
  if (base.endsWith('.js.map')) return false;
  if (STRIPPED_DIRS.has(base)) {
    const parent = path.basename(path.dirname(src));
    // Only strip when the directory sits directly inside a package (or scoped
    // package).  Never strip "test" inside deeply-nested paths that may be
    // runtime-required.
    if (!parent.startsWith('@') && parent !== 'node_modules') {
      return false;
    }
  }
  return true;
}

function isExcludedPackage(packagePath) {
  const name = path.basename(packagePath);
  const parent = path.basename(path.dirname(packagePath));
  const fullName = parent.startsWith('@') ? `${parent}/${name}` : name;
  return EXCLUDED_PACKAGES.has(fullName);
}

async function copyPackageDir(sourceDir, targetDir, packagePath) {
  if (isExcludedPackage(packagePath)) return;
  if (!(await shouldIncludePackage(packagePath))) return;

  const relativePath = path.relative(sourceDir, packagePath);
  const targetPath = path.join(targetDir, relativePath);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.cp(packagePath, targetPath, {
    recursive: true,
    dereference: true,
    filter: shouldCopyEntry,
  });
}

async function stageNodeModules(sourceDir, targetDir, dependencyTree) {
  await fs.rm(targetDir, { recursive: true, force: true });
  await fs.mkdir(path.dirname(targetDir), { recursive: true });

  const packagePaths = collapseDependencyPaths(
    collectDependencyPaths(
      dependencyTree,
      sourceDir,
      new Set(),
      Object.keys(dependencyTree._dependencies || {}),
    ),
  );

  for (const packagePath of packagePaths) {
    const stats = await fs.lstat(packagePath);
    if (stats.isSymbolicLink()) continue;
    await copyPackageDir(sourceDir, targetDir, packagePath);
  }
}

async function stageInstalledNodeModules(sourceDir, targetDir) {
  await fs.rm(targetDir, { recursive: true, force: true });
  await fs.mkdir(targetDir, { recursive: true });

  for (const entry of await fs.readdir(sourceDir, { withFileTypes: true })) {
    if (entry.name === '.bin') continue;

    const entryPath = path.join(sourceDir, entry.name);
    if (!entry.isDirectory()) continue;

    if (entry.name.startsWith('@')) {
      for (const scopedEntry of await fs.readdir(entryPath, {
        withFileTypes: true,
      })) {
        if (!scopedEntry.isDirectory()) continue;
        await copyPackageDir(
          sourceDir,
          targetDir,
          path.join(entryPath, scopedEntry.name),
        );
      }
      continue;
    }

    await copyPackageDir(sourceDir, targetDir, entryPath);
  }
}

async function main() {
  await fs.access(rootNodeModulesSource);
  await fs.access(containerNodeModulesSource);

  await fs.mkdir(runtimeBinDir, { recursive: true });
  await fs.copyFile(process.execPath, bundledNodePath);
  await fs.chmod(bundledNodePath, 0o755);

  await stageNodeModules(
    rootNodeModulesSource,
    rootNodeModulesTarget,
    readDependencyTree(repoRoot),
  );
  await stageInstalledNodeModules(
    containerNodeModulesSource,
    containerNodeModulesTarget,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
