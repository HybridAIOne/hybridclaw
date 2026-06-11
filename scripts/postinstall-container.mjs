import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(scriptPath);

function normalizeExecutablePath(filePath) {
  const resolved = path.resolve(filePath);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

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

  // Check container/node_modules directly. require.resolve is wrong in both
  // directions here: it walks up to the outer package's node_modules (a dep
  // missing from the container tree counts as "present"), and it throws
  // ERR_PACKAGE_PATH_NOT_EXPORTED for deps whose exports map hides
  // package.json (an installed dompurify counts as "missing").
  for (const dependency of dependencies) {
    const packageJsonPath = path.join(
      containerDir,
      'node_modules',
      ...dependency.split('/'),
      'package.json',
    );
    if (!fs.existsSync(packageJsonPath)) {
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
  const npmExecName = path.basename(npmExecPath).toLowerCase();
  // Reuse npm_execpath only when it is npm's JS entrypoint (npm-cli.js):
  // pnpm, yarn, and bun set npm_execpath too (running their CLIs with
  // npm-only flags fails the install), and npm's own `npm`/`npm.cmd` shell
  // wrappers are not JavaScript, so process.execPath cannot run them.
  const invokedByNpm = npmExecName.startsWith('npm-cli');
  const installArgs = [
    '--prefix',
    containerDir,
    'install',
    '--ignore-scripts',
    '--omit=dev',
    '--no-audit',
    '--fund=false',
    '--workspaces=false',
  ];

  if (
    invokedByNpm &&
    npmExecPath &&
    path.isAbsolute(npmExecPath) &&
    fs.existsSync(npmExecPath)
  ) {
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

export function buildBootstrapEnv(env = process.env) {
  const nextEnv = { ...env };
  delete nextEnv.npm_command;
  delete nextEnv.npm_config_global;
  delete nextEnv.npm_config_local_prefix;
  delete nextEnv.npm_config_prefix;
  delete nextEnv.npm_config_user_agent;
  delete nextEnv.npm_execpath;
  delete nextEnv.npm_lifecycle_event;
  delete nextEnv.npm_lifecycle_script;
  delete nextEnv.npm_prefix;

  for (const key of Object.keys(nextEnv)) {
    if (key.startsWith('npm_package_')) {
      delete nextEnv[key];
    }
  }

  return nextEnv;
}

export function bootstrapContainerDependencies(
  containerDir,
  env = process.env,
) {
  const { command, args } = resolveNpmCommand(containerDir, env);
  const childEnv = buildBootstrapEnv(env);
  return spawnSync(command, args, {
    cwd: containerDir,
    env: childEnv,
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

const invokedAsScript = (() => {
  const argv1 = String(process.argv[1] || '').trim();
  if (!argv1) return false;
  return normalizeExecutablePath(argv1) === normalizeExecutablePath(scriptPath);
})();

if (invokedAsScript) {
  try {
    process.exitCode = runPostinstall();
  } catch (error) {
    console.error(
      `[hybridclaw] failed to install packaged container runtime dependencies: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
