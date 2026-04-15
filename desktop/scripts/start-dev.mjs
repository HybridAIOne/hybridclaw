import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const APP_NAME = 'HybridClaw';
const APP_ID = 'com.hybridaione.hybridclaw.desktop.dev';

const currentFile = fileURLToPath(import.meta.url);
const scriptsDir = path.dirname(currentFile);
const desktopDir = path.resolve(scriptsDir, '..');
const repoRoot = path.resolve(desktopDir, '..');
const sourceAppPath = path.join(
  repoRoot,
  'node_modules',
  'electron',
  'dist',
  'Electron.app',
);
const devBundleRoot = path.join(desktopDir, '.electron-dev');
const devAppPath = path.join(devBundleRoot, `${APP_NAME}.app`);
const devPlistPath = path.join(devAppPath, 'Contents', 'Info.plist');
const devIconPath = path.join(devAppPath, 'Contents', 'Resources', 'electron.icns');
const desktopIconPath = path.join(desktopDir, 'build', 'icon.icns');

function runPlistBuddy(command) {
  const result = spawnSync('/usr/libexec/PlistBuddy', ['-c', command, devPlistPath], {
    stdio: 'inherit',
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

async function prepareDevBundle() {
  if (process.platform !== 'darwin') {
    return null;
  }

  await fs.rm(devBundleRoot, { recursive: true, force: true });
  await fs.mkdir(devBundleRoot, { recursive: true });
  const copyResult = spawnSync('/bin/cp', ['-R', sourceAppPath, devAppPath], {
    stdio: 'inherit',
  });

  if (copyResult.status !== 0) {
    process.exit(copyResult.status ?? 1);
  }

  runPlistBuddy(`Set :CFBundleName ${APP_NAME}`);
  runPlistBuddy(`Set :CFBundleDisplayName ${APP_NAME}`);
  runPlistBuddy(`Set :CFBundleIdentifier ${APP_ID}`);

  try {
    await fs.copyFile(desktopIconPath, devIconPath);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return devAppPath;
    }
    throw error;
  }

  return devAppPath;
}

async function main() {
  const preparedExecutablePath = await prepareDevBundle();

  if (process.argv.includes('--prepare-only')) {
    return;
  }

  if (process.platform !== 'darwin') {
    const child = spawn(
      path.join(repoRoot, 'node_modules', '.bin', 'electron'),
      ['.'],
      {
        cwd: desktopDir,
        stdio: 'inherit',
        env: process.env,
      },
    );
    child.on('exit', (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      process.exit(code ?? 0);
    });
    return;
  }

  const child = spawn('/usr/bin/open', ['-W', '-n', preparedExecutablePath, '--args', desktopDir], {
    stdio: 'inherit',
    env: {
      ...process.env,
      HYBRIDCLAW_DESKTOP_NODE_EXECUTABLE: process.execPath,
    },
  });

  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
