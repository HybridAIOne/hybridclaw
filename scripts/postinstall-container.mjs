import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(scriptPath);

export function resolvePackageRoot(baseDir = scriptDir) {
  return path.resolve(baseDir, '..');
}

export function isSourceCheckout(packageRoot) {
  return fs.existsSync(path.join(packageRoot, 'src'));
}

export function readContainerDependencyNames(containerDir) {
  const packageJsonPath = path.join(containerDir, 'package.json');
  if (!fs.existsSync(packageJsonPath)) return [];
  const raw = fs.readFileSync(packageJsonPath, 'utf-8');
  const parsed = JSON.parse(raw);
  return Object.keys(parsed.dependencies || {}).sort((left, right) =>
    left.localeCompare(right),
  );
}

export function findMissingContainerDependencies(containerDir) {
  const dependencies = readContainerDependencyNames(containerDir);
  const missing = [];

  for (const dependency of dependencies) {
    try {
      require.resolve(`${dependency}/package.json`, {
        paths: [containerDir],
      });
    } catch {
      missing.push(dependency);
    }
  }

  return missing;
}

export function inspectContainerBootstrap(packageRoot) {
  const containerDir = path.join(packageRoot, 'container');
  const containerPackageJsonPath = path.join(containerDir, 'package.json');

  if (!fs.existsSync(containerPackageJsonPath)) {
    return {
      needed: false,
      reason: 'missing-container-package',
      containerDir,
      missingDependencies: [],
    };
  }

  if (isSourceCheckout(packageRoot)) {
    return {
      needed: false,
      reason: 'source-checkout',
      containerDir,
      missingDependencies: [],
    };
  }

  const missingDependencies = findMissingContainerDependencies(containerDir);
  if (missingDependencies.length === 0) {
    return {
      needed: false,
      reason: 'dependencies-present',
      containerDir,
      missingDependencies: [],
    };
  }

  return {
    needed: true,
    reason: 'missing-dependencies',
    containerDir,
    missingDependencies,
  };
}

export function resolveNpmCommand(containerDir, env = process.env) {
  const npmExecPath = String(env.npm_execpath || '').trim();
  const installArgs = ['--prefix', containerDir, 'install', '--omit=dev'];

  if (npmExecPath && path.isAbsolute(npmExecPath) && fs.existsSync(npmExecPath)) {
    return {
      command: process.execPath,
      args: [npmExecPath, ...installArgs],
    };
  }

  return {
    command: 'npm',
    args: installArgs,
  };
}

export function bootstrapContainerDependencies(containerDir, env = process.env) {
  const { command, args } = resolveNpmCommand(containerDir, env);
  return spawnSync(command, args, {
    cwd: containerDir,
    env,
    stdio: 'inherit',
  });
}

export function runPostinstall(packageRoot = resolvePackageRoot()) {
  const inspection = inspectContainerBootstrap(packageRoot);
  if (!inspection.needed) return 0;

  const summary = inspection.missingDependencies.join(', ');
  console.log(
    `[hybridclaw] installing packaged container runtime dependencies (${summary})`,
  );

  const result = bootstrapContainerDependencies(inspection.containerDir);
  if (result.error) throw result.error;
  return result.status ?? 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try {
    process.exitCode = runPostinstall();
  } catch (error) {
    console.error(
      `[hybridclaw] failed to install packaged container runtime dependencies: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
