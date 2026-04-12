import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';

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
  } catch {
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
    const resolved = path.resolve(startPath);
    current =
      fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()
        ? resolved
        : path.dirname(resolved);
  } catch {
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
      const args = ['add', '-g', `${packageName}@latest`];
      return { bin: 'pnpm', args, display: `pnpm ${args.join(' ')}` };
    }
    case 'yarn': {
      const args = ['global', 'add', `${packageName}@latest`];
      return { bin: 'yarn', args, display: `yarn ${args.join(' ')}` };
    }
    case 'bun': {
      const args = ['add', '-g', `${packageName}@latest`];
      return { bin: 'bun', args, display: `bun ${args.join(' ')}` };
    }
    default: {
      const args = ['install', '-g', `${packageName}@latest`];
      return { bin: 'npm', args, display: `npm ${args.join(' ')}` };
    }
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

  console.log('Update complete. Re-run `hybridclaw update --check` to verify.');
  console.log(
    'If the gateway is already running, restart it to load the new version:',
  );
  console.log('  hybridclaw gateway restart');
}
