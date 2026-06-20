import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const RUNTIME_CACHE_VERSION = 2;
const currentFile = fileURLToPath(import.meta.url);
const scriptsDir = path.dirname(currentFile);
const desktopDir = path.resolve(scriptsDir, '..');
const repoRoot = path.resolve(desktopDir, '..');
const runtimeBinDir = path.join(desktopDir, 'build', 'runtime-bin');
const runtimeDepsDir = path.join(desktopDir, 'build', 'runtime-deps');
const runtimeCacheManifestPath = path.join(
  runtimeDepsDir,
  '.hybridclaw-runtime-cache.json',
);
const rootNodeModulesSource = path.join(repoRoot, 'node_modules');
const rootNodeModulesTarget = path.join(runtimeDepsDir, 'root-node_modules');
const containerNodeModulesSource = path.join(
  repoRoot,
  'container',
  'node_modules',
);
const containerNodeModulesTarget = path.join(
  runtimeDepsDir,
  'container-node_modules',
);
const bundledNodePath = path.join(runtimeBinDir, 'node');
const runtimeTarget = {
  platform:
    process.env.HYBRIDCLAW_DESKTOP_TARGET_PLATFORM ||
    process.env.npm_config_platform ||
    process.platform,
  arch:
    process.env.HYBRIDCLAW_DESKTOP_TARGET_ARCH ||
    process.env.npm_config_arch ||
    process.arch,
};
const runtimeCacheDisabled = ['0', 'false', 'off'].includes(
  String(process.env.HYBRIDCLAW_DESKTOP_RUNTIME_CACHE || '').toLowerCase(),
);

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

export async function shouldIncludePackage(
  packagePath,
  target = runtimeTarget,
) {
  const packageJsonPath = path.join(packagePath, 'package.json');

  try {
    const raw = await fs.readFile(packageJsonPath, 'utf8');
    const parsed = JSON.parse(raw);
    return (
      matchesConstraint(parsed.os, target.platform) &&
      matchesConstraint(parsed.cpu, target.arch)
    );
  } catch {
    return true;
  }
}

/** Packages excluded from the runtime bundle (browser-only / unused). */
const EXCLUDED_PACKAGES = new Set(['onnxruntime-web']);
const EXCLUDED_SCOPES = new Set(['@types']);

/**
 * Directory basenames stripped from every copied package to shed test fixtures
 * and other files that aren't needed at runtime.
 */
const STRIPPED_DIRS = new Set([
  '.github',
  '__tests__',
  'benchmark',
  'benchmarks',
  'coverage',
  'example',
  'examples',
  'test',
  'tests',
]);
const STRIPPED_FILE_SUFFIXES = [
  '.d.ts',
  '.d.cts',
  '.d.mts',
  '.js.map',
  '.cjs.map',
  '.mjs.map',
  '.map',
  '.tsbuildinfo',
];

function isDirectPackageChild(src, packagePath) {
  return path.dirname(src) === packagePath;
}

function shouldCopyOnnxRuntimeEntry(src, packagePath, target) {
  const relativePath = path.relative(packagePath, src);
  if (!relativePath) return true;

  const parts = relativePath.split(path.sep);
  if (parts[0] !== 'bin' || parts[1] !== 'napi-v3') return true;

  if (parts.length <= 2) return true;
  if (parts[2] !== target.platform) return false;

  if (parts.length === 3) return true;
  return parts[3] === target.arch;
}

export function shouldCopyEntry(src, packagePath, target = runtimeTarget) {
  const base = path.basename(src);
  if (STRIPPED_FILE_SUFFIXES.some((suffix) => base.endsWith(suffix))) {
    return false;
  }
  if (STRIPPED_DIRS.has(base)) {
    // Only strip top-level package dirs. Deeply nested directories can be
    // runtime data for some packages.
    if (isDirectPackageChild(src, packagePath)) {
      return false;
    }
  }
  if (getPackageName(packagePath) === 'onnxruntime-node') {
    return shouldCopyOnnxRuntimeEntry(src, packagePath, target);
  }
  return true;
}

function getPackageName(packagePath) {
  const name = path.basename(packagePath);
  const parent = path.basename(path.dirname(packagePath));
  return parent.startsWith('@') ? `${parent}/${name}` : name;
}

export function isExcludedPackage(packagePath) {
  const fullName = getPackageName(packagePath);
  const scope = fullName.startsWith('@') ? fullName.split('/')[0] : '';
  return EXCLUDED_PACKAGES.has(fullName) || EXCLUDED_SCOPES.has(scope);
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
    filter: (src) => shouldCopyEntry(src, packagePath),
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

async function readOptionalFileDigest(filePath) {
  try {
    const buffer = await fs.readFile(filePath);
    return createHash('sha256').update(buffer).digest('hex');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function readFileIdentity(filePath) {
  const stats = await fs.stat(filePath);
  return {
    path: filePath,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
  };
}

async function buildRuntimeCacheKey() {
  const files = [
    path.join(repoRoot, 'package.json'),
    path.join(repoRoot, 'package-lock.json'),
    path.join(repoRoot, 'npm-shrinkwrap.json'),
    path.join(repoRoot, 'container', 'package.json'),
    path.join(repoRoot, 'container', 'package-lock.json'),
    path.join(repoRoot, 'container', 'npm-shrinkwrap.json'),
    path.join(desktopDir, 'package.json'),
    currentFile,
  ];
  const fileDigests = [];

  for (const filePath of files) {
    fileDigests.push({
      path: path.relative(repoRoot, filePath),
      sha256: await readOptionalFileDigest(filePath),
    });
  }

  const payload = {
    version: RUNTIME_CACHE_VERSION,
    target: runtimeTarget,
    node: {
      version: process.version,
      executable: await readFileIdentity(process.execPath),
    },
    files: fileDigests,
  };

  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

async function runtimeStageIsCurrent(cacheKey) {
  try {
    const raw = await fs.readFile(runtimeCacheManifestPath, 'utf8');
    const manifest = JSON.parse(raw);
    if (manifest.cacheKey !== cacheKey) return false;

    await fs.access(bundledNodePath);
    await fs.access(rootNodeModulesTarget);
    await fs.access(containerNodeModulesTarget);
    return true;
  } catch {
    return false;
  }
}

async function writeRuntimeCacheManifest(cacheKey) {
  await fs.mkdir(runtimeDepsDir, { recursive: true });
  await fs.writeFile(
    runtimeCacheManifestPath,
    `${JSON.stringify(
      {
        cacheKey,
        generatedAt: new Date().toISOString(),
        target: runtimeTarget,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

async function main() {
  const cacheKey = await buildRuntimeCacheKey();
  if (!runtimeCacheDisabled && (await runtimeStageIsCurrent(cacheKey))) {
    console.log(
      `Desktop runtime cache is current for ${runtimeTarget.platform}/${runtimeTarget.arch}.`,
    );
    return;
  }

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
  await writeRuntimeCacheManifest(cacheKey);
}

if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
