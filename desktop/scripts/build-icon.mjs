import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const currentFile = fileURLToPath(import.meta.url);
const scriptsDir = path.dirname(currentFile);
const desktopDir = path.resolve(scriptsDir, '..');
const buildDir = path.join(desktopDir, 'build');

if (process.platform === 'darwin') {
  const result = spawnSync('swift', ['scripts/generate-mac-icon.swift'], {
    cwd: desktopDir,
    stdio: 'inherit',
  });
  process.exit(result.status ?? 1);
}

const committedAssets = [
  path.join(buildDir, 'icon.png'),
  path.join(buildDir, 'icon.icns'),
  path.join(buildDir, 'background.png'),
  path.join(buildDir, 'background@2x.png'),
];
const missing = committedAssets.filter((target) => !fs.existsSync(target));

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
