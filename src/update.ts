import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { DEFAULT_RUNTIME_HOME_DIR } from './config/runtime-paths.js';
import { containerBootstrapScriptPath } from './infra/install-root.js';
import { logger } from './logger.js';

const DEFAULT_PACKAGE_NAME = '@hybridaione/hybridclaw';

type InstallKind = 'source' | 'package' | 'unknown';
type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

interface UpdateArgs {
  checkOnly: boolean;
  yes: boolean;
  help: boolean;
}

interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
}

interface InstallContext {
  kind: InstallKind;
  root: string | null;
  packageManager: PackageManager;
}

interface UpdateCommand {
  bin: string;
  args: string[];
  display: string;
}

interface LatestVersionResult {
  version: string | null;
  error: string | null;
}

interface PackageManifest {
  name?: unknown;
  version?: unknown;
}

interface PackageInfo {
  name: string | null;
  version: string | null;
}

const REVIEWED_NATIVE_REBUILD_PACKAGES = [
  'better-sqlite3',
  'node-pty',
  'onnxruntime-node',
];

function readPackageInfo(packageJsonPath: string): PackageInfo {
  try {
    const raw = fs.readFileSync(packageJsonPath, 'utf-8');
    const parsed = JSON.parse(raw) as PackageManifest;
    const name =
      typeof parsed.name === 'string' && parsed.name.trim()
        ? parsed.name.trim()
        : null;
    const version =
      typeof parsed.version === 'string' && parsed.version.trim()
        ? parsed.version.trim()
        : null;
    return { name, version };
  } catch (error) {
    logger.debug(
      { packageJsonPath, err: error },
      'Could not read package manifest',
    );
    return { name: null, version: null };
  }
}

function parseUpdateArgs(args: string[]): UpdateArgs {
  const parsed: UpdateArgs = { checkOnly: false, yes: false, help: false };
  for (const raw of args) {
    const arg = raw.trim();
    if (!arg) continue;
    if (arg === 'status' || arg === '--check') {
      parsed.checkOnly = true;
      continue;
    }
    if (arg === '--yes' || arg === '-y') {
      parsed.yes = true;
      continue;
    }
    if (arg === '--help' || arg === '-h' || arg === 'help') {
      parsed.help = true;
      continue;
    }
    throw new Error(`Unknown update option: ${arg}`);
  }
  return parsed;
}

function findNearestPackageRoot(startPath: string | undefined): string | null {
  if (!startPath) return null;

  let current: string;
  try {
    const resolved = realpathOrSelf(startPath);
    current =
      fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()
        ? resolved
        : path.dirname(resolved);
  } catch (error) {
    logger.debug(
      { startPath, err: error },
      'Could not determine the package root for the CLI entry path',
    );
    return null;
  }

  for (;;) {
    if (fs.existsSync(path.join(current, 'package.json'))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function resolvePackageName(entryPath: string | undefined): string {
  const entryRoot = findNearestPackageRoot(entryPath);
  if (entryRoot) {
    const info = readPackageInfo(path.join(entryRoot, 'package.json'));
    if (info.name) return info.name;
  }

  const cwdInfo = readPackageInfo(path.join(process.cwd(), 'package.json'));
  if (cwdInfo.name) return cwdInfo.name;

  return DEFAULT_PACKAGE_NAME;
}

function detectPackageManager(): PackageManager {
  const userAgent = (process.env.npm_config_user_agent || '').toLowerCase();
  if (userAgent.startsWith('pnpm/')) return 'pnpm';
  if (userAgent.startsWith('yarn/')) return 'yarn';
  if (userAgent.startsWith('bun/')) return 'bun';
  if (userAgent.startsWith('npm/')) return 'npm';

  const execPath = (process.env.npm_execpath || '').toLowerCase();
  if (execPath.includes('pnpm')) return 'pnpm';
  if (execPath.includes('yarn')) return 'yarn';
  if (execPath.includes('bun')) return 'bun';
  if (execPath.includes('npm')) return 'npm';

  return 'npm';
}

function detectInstallContext(
  packageName: string,
  entryPath: string | undefined,
): InstallContext {
  const preferredManager = detectPackageManager();
  const entryRoot = findNearestPackageRoot(entryPath);
  const cwdRoot = findNearestPackageRoot(process.cwd());
  const cwdInfo = readPackageInfo(path.join(process.cwd(), 'package.json'));

  if (
    cwdInfo.name === packageName &&
    fs.existsSync(path.join(process.cwd(), '.git'))
  ) {
    return {
      kind: 'source',
      root: process.cwd(),
      packageManager: preferredManager,
    };
  }

  if (!entryRoot) {
    return { kind: 'unknown', root: null, packageManager: preferredManager };
  }

  const entryInfo = readPackageInfo(path.join(entryRoot, 'package.json'));
  if (entryInfo.name !== packageName) {
    if (cwdRoot && cwdInfo.name === packageName) {
      return {
        kind: fs.existsSync(path.join(cwdRoot, '.git')) ? 'source' : 'unknown',
        root: cwdRoot,
        packageManager: preferredManager,
      };
    }
    return {
      kind: 'unknown',
      root: entryRoot,
      packageManager: preferredManager,
    };
  }

  if (fs.existsSync(path.join(entryRoot, '.git'))) {
    return {
      kind: 'source',
      root: entryRoot,
      packageManager: preferredManager,
    };
  }

  if (entryRoot.includes(`${path.sep}node_modules${path.sep}`)) {
    return {
      kind: 'package',
      root: entryRoot,
      packageManager: preferredManager,
    };
  }

  return { kind: 'unknown', root: entryRoot, packageManager: preferredManager };
}

function parseSemver(value: string): ParsedSemver | null {
  const normalized = value.trim().replace(/^v/i, '');
  const match = normalized.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) return null;

  const major = Number.parseInt(match[1], 10);
  const minor = Number.parseInt(match[2], 10);
  const patch = Number.parseInt(match[3], 10);
  if (
    !Number.isFinite(major) ||
    !Number.isFinite(minor) ||
    !Number.isFinite(patch)
  )
    return null;

  return {
    major,
    minor,
    patch,
    prerelease: match[4] || null,
  };
}

function compareSemver(a: string, b: string): number | null {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (!left || !right) return null;

  if (left.major !== right.major) return left.major < right.major ? -1 : 1;
  if (left.minor !== right.minor) return left.minor < right.minor ? -1 : 1;
  if (left.patch !== right.patch) return left.patch < right.patch ? -1 : 1;

  if (left.prerelease === right.prerelease) return 0;
  if (!left.prerelease && right.prerelease) return 1;
  if (left.prerelease && !right.prerelease) return -1;

  return String(left.prerelease).localeCompare(String(right.prerelease));
}

function fetchLatestVersion(packageName: string): LatestVersionResult {
  const result = spawnSync('npm', ['view', packageName, 'version'], {
    encoding: 'utf-8',
    timeout: 15_000,
  });

  if (result.error) {
    return { version: null, error: result.error.message };
  }

  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    const message = detail
      ? detail.split('\n').slice(-1)[0]
      : `npm exited with code ${result.status ?? 1}`;
    return { version: null, error: message };
  }

  const version = (result.stdout || '').trim().split(/\s+/).pop() || '';
  if (!version) {
    return { version: null, error: 'npm returned an empty version response' };
  }

  return { version, error: null };
}

function commandAvailable(command: string): boolean {
  const result = spawnSync(command, ['--version'], {
    stdio: 'ignore',
  });
  if (result.error) return false;
  return result.status === 0;
}

function resolveAvailablePackageManager(
  preferred: PackageManager,
): PackageManager | null {
  const order: PackageManager[] = [preferred, 'npm', 'pnpm', 'yarn', 'bun'];
  const checked = new Set<PackageManager>();
  for (const candidate of order) {
    if (checked.has(candidate)) continue;
    checked.add(candidate);
    if (commandAvailable(candidate)) return candidate;
  }
  return null;
}

function buildUpdateCommand(
  packageManager: PackageManager,
  packageName: string,
): UpdateCommand {
  switch (packageManager) {
    case 'pnpm': {
      const args = ['add', '-g', '--ignore-scripts', `${packageName}@latest`];
      return { bin: 'pnpm', args, display: `pnpm ${args.join(' ')}` };
    }
    case 'yarn': {
      const args = [
        'global',
        'add',
        '--ignore-scripts',
        `${packageName}@latest`,
      ];
      return { bin: 'yarn', args, display: `yarn ${args.join(' ')}` };
    }
    case 'bun': {
      const args = ['add', '-g', '--ignore-scripts', `${packageName}@latest`];
      return { bin: 'bun', args, display: `bun ${args.join(' ')}` };
    }
    default: {
      // `--omit=dev` keeps the published workspace shrinkwrap's development
      // tree out of the global install. `--no-fund`/`--no-audit` are npm-specific
      // and trim the funding/audit noise from the self-update output. These are
      // intentionally not added to the pnpm/yarn/bun branches, which don't
      // support the same flags or emit that output. Deprecation warnings are
      // left visible on purpose (see SECURITY.md and the npm supply-chain notes).
      const args = [
        'install',
        '-g',
        '--ignore-scripts',
        '--omit=dev',
        '--no-fund',
        '--no-audit',
        `${packageName}@latest`,
      ];
      return { bin: 'npm', args, display: `npm ${args.join(' ')}` };
    }
  }
}

function packagePathFromNodeModulesRoot(
  nodeModulesRoot: string | null,
  packageName: string,
): string | null {
  if (!nodeModulesRoot) return null;
  const segments = packageName.split('/').filter(Boolean);
  if (segments.length === 0) return null;

  const packageRoot = path.join(nodeModulesRoot, ...segments);
  const info = readPackageInfo(path.join(packageRoot, 'package.json'));
  return info.name === packageName ? packageRoot : null;
}

function resolveBunGlobalNodeModulesRoot(globalBinDir: string): string {
  return path.resolve(globalBinDir, '..', 'install', 'global', 'node_modules');
}

function resolveUpdatedPackageRoot(
  packageManager: PackageManager,
  packageName: string,
): string | null {
  const command =
    packageManager === 'yarn'
      ? { bin: 'yarn', args: ['global', 'dir'] }
      : packageManager === 'bun'
        ? { bin: 'bun', args: ['pm', 'bin', '-g'] }
        : { bin: packageManager, args: ['root', '-g'] };
  const result = spawnSync(command.bin, command.args, {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (result.error || result.status !== 0) return null;

  const rawRoot = (result.stdout || '').trim().split('\n').pop()?.trim();
  if (!rawRoot) return null;
  const nodeModulesRoot =
    packageManager === 'yarn'
      ? path.join(rawRoot, 'node_modules')
      : packageManager === 'bun'
        ? resolveBunGlobalNodeModulesRoot(rawRoot)
        : rawRoot;
  return packagePathFromNodeModulesRoot(nodeModulesRoot, packageName);
}

function realpathOrSelf(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch (error) {
    logger.debug(
      { target, err: error },
      'Could not resolve the real path; using the literal path',
    );
    return path.resolve(target);
  }
}

// True only when the running entry point is the package manager's *global*
// install of HybridClaw. A project-local dependency or npx cache resolves to
// the same package name and a node_modules path, but it lives outside the
// global root; updating it would run `npm install -g` and mutate the user's
// global environment from a local invocation, so callers must not prompt for
// or auto-update it.
function isGlobalPackageInstall(
  install: InstallContext,
  packageName: string,
): boolean {
  if (install.kind !== 'package' || !install.root) return false;
  const globalRoot = resolveUpdatedPackageRoot(
    install.packageManager,
    packageName,
  );
  if (!globalRoot) return false;
  return realpathOrSelf(globalRoot) === realpathOrSelf(install.root);
}

function runExplicitPostinstall(installRoot: string | null): void {
  if (!installRoot) return;
  const scriptPath = containerBootstrapScriptPath(installRoot);
  if (!fs.existsSync(scriptPath)) return;

  const result = spawnSync(process.execPath, [scriptPath], {
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Container dependency bootstrap failed with exit code ${result.status ?? 1}.`,
    );
  }
}

function buildRebuildEnv(env = process.env): NodeJS.ProcessEnv {
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
  nextEnv.ONNXRUNTIME_NODE_INSTALL_CUDA = 'skip';
  for (const key of Object.keys(nextEnv)) {
    if (key.startsWith('npm_package_')) {
      delete nextEnv[key];
    }
  }
  return nextEnv;
}

function rebuildReviewedNativeDependencies(installRoot: string | null): void {
  if (!installRoot) return;
  const result = spawnSync(
    'npm',
    [
      'rebuild',
      ...REVIEWED_NATIVE_REBUILD_PACKAGES,
      '--ignore-scripts=false',
      '--no-audit',
      '--fund=false',
    ],
    {
      cwd: installRoot,
      env: buildRebuildEnv(),
      stdio: 'inherit',
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Native dependency rebuild failed with exit code ${result.status ?? 1}.`,
    );
  }
}

async function askForConfirmation(message: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = (await rl.question(`${message} [y/N] `))
      .trim()
      .toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

function runUpdateInstall(command: UpdateCommand): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command.bin, command.args, {
      stdio: 'inherit',
    });
    child.on('error', (err) => reject(err));
    child.on('close', (code) => resolve(code ?? 1));
  });
}

const VERSION_CACHE_FILE = 'version-check.json';
const VERSION_CACHE_TTL_MS = 20 * 60 * 60 * 1000;
const REFRESH_VERSION_CACHE_COMMAND = '__refresh-version-cache';

interface VersionCache {
  latestVersion: string;
  // ISO-8601 timestamp of the last successful registry check.
  lastCheckedAt: string;
}

function versionCachePath(): string {
  return path.join(DEFAULT_RUNTIME_HOME_DIR, VERSION_CACHE_FILE);
}

function readVersionCache(): VersionCache | null {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(versionCachePath(), 'utf-8'),
    ) as Partial<VersionCache>;
    if (
      typeof parsed.latestVersion === 'string' &&
      parsed.latestVersion.trim() &&
      typeof parsed.lastCheckedAt === 'string' &&
      !Number.isNaN(Date.parse(parsed.lastCheckedAt))
    ) {
      return {
        latestVersion: parsed.latestVersion.trim(),
        lastCheckedAt: parsed.lastCheckedAt,
      };
    }
  } catch (error) {
    logger.debug(
      { err: error },
      'Could not read the version cache; treating it as absent',
    );
  }
  return null;
}

function isVersionCacheFresh(cache: VersionCache): boolean {
  const age = Date.now() - Date.parse(cache.lastCheckedAt);
  return age >= 0 && age < VERSION_CACHE_TTL_MS;
}

function writeVersionCache(latestVersion: string): void {
  const cache: VersionCache = {
    latestVersion,
    lastCheckedAt: new Date().toISOString(),
  };
  // Overwriting temp+rename (writeFileAtomicExclusive can't be reused here: it
  // hard-links with flag 'wx' and throws once the cache file already exists).
  const filePath = versionCachePath();
  const tempPath = `${filePath}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  try {
    // The cache shares the runtime home with secrets, so create the directory
    // and file with the restrictive modes the rest of the runtime uses rather
    // than leaving them at the umask default.
    fs.mkdirSync(DEFAULT_RUNTIME_HOME_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(tempPath, `${JSON.stringify(cache)}\n`, {
      encoding: 'utf-8',
      mode: 0o600,
    });
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    logger.debug(
      { err: error, filePath },
      'Failed to write the version cache; the next launch retries',
    );
    fs.rmSync(tempPath, { force: true });
  }
}

// Runs inside the detached `__refresh-version-cache` child process. It owns its
// own process, so it may block on the registry call; the result lands in the
// cache for the next interactive launch to read.
export function refreshVersionCache(): void {
  const packageName = resolvePackageName(process.argv[1]);
  const latest = fetchLatestVersion(packageName);
  if (latest.version) {
    writeVersionCache(latest.version);
  }
}

function spawnVersionCacheRefresh(): void {
  const cliEntry = process.argv[1];
  if (!cliEntry) return;
  try {
    // Do not forward process.execArgv: an inherited exclusive flag such as
    // --inspect would make the child fail to bind its debug port and exit
    // before it can refresh the cache.
    const child = spawn(
      process.execPath,
      [cliEntry, REFRESH_VERSION_CACHE_COMMAND],
      { detached: true, stdio: 'ignore' },
    );
    child.unref();
  } catch (error) {
    logger.debug(
      { err: error },
      'Failed to spawn the background version-cache refresh; the next launch retries',
    );
  }
}

// Returns true when an update was installed and the caller should stop (this
// process is still running the old code). Returns false to continue launching.
export async function maybePromptStartupUpdate(
  currentVersion: string,
): Promise<boolean> {
  // Only suggest updates in an interactive terminal. Non-TTY launches
  // (CI, the detached gateway daemon, scripts) must never block on a prompt.
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;

  const packageName = resolvePackageName(process.argv[1]);
  const install = detectInstallContext(packageName, process.argv[1]);
  // A package-manager install is the only kind we can upgrade in place. Source
  // checkouts update via git; unknown installs are left untouched. (Whether a
  // `package` install is the *global* one is confirmed lazily below.)
  if (install.kind !== 'package') return false;

  // Cache-first, like Codex: decide using the previously cached latest version
  // so startup never waits on the network. Refresh in a detached child when the
  // cache is missing or stale; a newly learned version surfaces next launch.
  const cache = readVersionCache();
  if (!cache || !isVersionCacheFresh(cache)) {
    spawnVersionCacheRefresh();
  }
  if (!cache) return false;
  if (compareSemver(currentVersion, cache.latestVersion) !== -1) return false;

  // Confirm this is the global install before prompting. A project-local or npx
  // copy matches the package name but auto-updating it would run a global
  // install and mutate the user's environment. This `npm root -g` lookup is
  // done here — after we know an update exists — so it stays off the common
  // startup path where nothing is out of date.
  if (!isGlobalPackageInstall(install, packageName)) return false;

  console.log(`Update available: ${currentVersion} -> ${cache.latestVersion}`);
  let confirmed = false;
  try {
    confirmed = await askForConfirmation('Update HybridClaw now?');
  } catch (error) {
    logger.debug(
      { err: error },
      'Update confirmation prompt aborted (e.g. Ctrl-C); treating as a decline',
    );
    confirmed = false;
  }
  if (!confirmed) {
    console.log('Skipping update. Run `hybridclaw update` to update later.');
    return false;
  }

  // Delegate to the full update command so the install, native rebuild,
  // postinstall, and restart of any running gateway all match `hybridclaw
  // update`. The caller exits afterward so we never continue into the TUI or
  // gateway on the old code.
  await runUpdateCommand(['--yes'], currentVersion);
  return true;
}

export function printUpdateUsage(): void {
  console.log(`Usage: hybridclaw update [status] [--check] [--yes]

Checks the latest published HybridClaw version and updates global npm installs.

Options:
  status, --check  Check for updates without installing
  --yes, -y        Skip confirmation prompt before install`);
}

export async function runUpdateCommand(
  args: string[],
  currentVersion: string,
): Promise<void> {
  const options = parseUpdateArgs(args);
  if (options.help) {
    printUpdateUsage();
    return;
  }

  const packageName = resolvePackageName(process.argv[1]);
  const install = detectInstallContext(packageName, process.argv[1]);
  const latest = fetchLatestVersion(packageName);
  const comparison = latest.version
    ? compareSemver(currentVersion, latest.version)
    : null;

  console.log(`Current version: ${currentVersion}`);
  if (latest.version) {
    console.log(`Latest version:  ${latest.version}`);
  } else {
    console.log('Latest version:  unavailable (npm registry check failed)');
  }

  if (install.kind === 'source') {
    console.log('');
    console.log(
      `Source checkout detected at ${install.root || process.cwd()}.`,
    );
    console.log('To update, run:');
    console.log('  git pull --rebase');
    console.log('  npm install');
    console.log('  npm run build');
    console.log('  npm run build:container    # if container sources changed');
    if (latest.error) {
      console.log(`Registry check warning: ${latest.error}`);
    }
    return;
  }

  if (latest.version && comparison === -1) {
    console.log(`Update available: ${currentVersion} -> ${latest.version}`);
  } else if (latest.version && comparison === 0) {
    console.log('HybridClaw is already up to date.');
  } else if (latest.version && comparison === 1) {
    console.log(
      'Installed version is newer than npm latest; skipping automatic update.',
    );
  } else if (latest.version) {
    console.log(
      'Version comparison unavailable; semver format not recognized.',
    );
  }

  const manager = resolveAvailablePackageManager(install.packageManager);
  if (!manager) {
    throw new Error(
      'No supported package manager found (npm, pnpm, yarn, bun).',
    );
  }
  const updateCommand = buildUpdateCommand(manager, packageName);

  if (options.checkOnly) {
    if (latest.error) {
      console.log(`Registry check warning: ${latest.error}`);
    }
    if (!latest.version || comparison === -1 || comparison === null) {
      console.log(`To update, run: ${updateCommand.display}`);
    }
    return;
  }

  if (latest.version && comparison !== null && comparison >= 0) {
    return;
  }

  console.log(`Update command: ${updateCommand.display}`);
  if (!options.yes) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      console.log(
        'Non-interactive shell detected. Re-run with `--yes` to apply the update.',
      );
      return;
    }
    const confirmed = await askForConfirmation('Proceed with update now?');
    if (!confirmed) {
      console.log('Update cancelled.');
      return;
    }
  }

  const exitCode = await runUpdateInstall(updateCommand);
  if (exitCode !== 0) {
    throw new Error(`Update command failed with exit code ${exitCode}.`);
  }
  const updatedRoot =
    resolveUpdatedPackageRoot(manager, packageName) || install.root;
  rebuildReviewedNativeDependencies(updatedRoot);
  runExplicitPostinstall(updatedRoot);

  console.log('Update complete. Re-run `hybridclaw update --check` to verify.');

  const { requestExternalGatewayRestart } = await import(
    './gateway/gateway-restart.js'
  );
  const restart = await requestExternalGatewayRestart();
  if (restart.status === 'restarted') {
    console.log(
      `Restarting gateway (pid ${restart.pid}) with original parameters to load the new version.`,
    );
  } else if (restart.status === 'failed') {
    const pidSuffix = restart.pid ? ` (pid ${restart.pid})` : '';
    console.log(
      `Could not auto-restart gateway${pidSuffix}: ${restart.reason}`,
    );
    console.log('To load the new version, run: hybridclaw gateway restart');
  }
}
