import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const currentFile = fileURLToPath(import.meta.url);
const scriptsDir = path.dirname(currentFile);
const desktopDir = path.resolve(scriptsDir, '..');
const buildDir = path.join(desktopDir, 'build');
const macIconInputs = [
  path.join(desktopDir, '..', 'docs', 'static', 'apple-touch-icon.png'),
  path.join(desktopDir, 'scripts', 'generate-mac-icon.swift'),
];
const macIconOutputs = [
  path.join(buildDir, 'icon.png'),
  path.join(buildDir, 'icon.icns'),
  path.join(buildDir, 'background.png'),
  path.join(buildDir, 'background@2x.png'),
  path.join(buildDir, 'icon-source.png'),
];

function latestMtime(paths) {
  return Math.max(...paths.map((target) => fs.statSync(target).mtimeMs));
}

function macIconAssetsAreCurrent() {
  try {
    return latestMtime(macIconOutputs) >= latestMtime(macIconInputs);
  } catch {
    return false;
  }
}

if (process.platform === 'darwin') {
  if (macIconAssetsAreCurrent()) {
    console.log('Desktop icon assets are current.');
    process.exit(0);
  }

  const result = spawnSync('swift', ['scripts/generate-mac-icon.swift'], {
    cwd: desktopDir,
    stdio: 'inherit',
  });
  if (result.error) {
    console.error(
      `Failed to invoke swift scripts/generate-mac-icon.swift: ${result.error.message}`,
    );
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

const isLinuxBuild =
  process.platform === 'linux' ||
  process.env.HYBRIDCLAW_DESKTOP_TARGET === 'linux';

const requiredAssets = isLinuxBuild
  ? [path.join(buildDir, 'icon.png')]
  : [
      path.join(buildDir, 'icon.png'),
      path.join(buildDir, 'icon.icns'),
      path.join(buildDir, 'background.png'),
      path.join(buildDir, 'background@2x.png'),
    ];
const missing = requiredAssets.filter((target) => !fs.existsSync(target));

if (missing.length > 0) {
  console.error(
    `Cannot build desktop icons on ${process.platform}: Swift toolchain is required to regenerate them, and the committed icon assets are missing:\n${missing
      .map((target) => `  - ${path.relative(desktopDir, target)}`)
      .join('\n')}`,
  );
  process.exit(1);
}

console.log(
  `Skipping macOS-only icon generation on ${process.platform}; using committed assets in desktop/build/.`,
);
