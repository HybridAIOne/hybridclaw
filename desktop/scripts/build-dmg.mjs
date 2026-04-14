import { once } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import appdmg from 'appdmg';

const currentFile = fileURLToPath(import.meta.url);
const scriptsDir = path.dirname(currentFile);
const desktopDir = path.resolve(scriptsDir, '..');
const releaseDir = path.join(desktopDir, 'release');
const packageJson = JSON.parse(
  await fs.readFile(path.join(desktopDir, 'package.json'), 'utf8'),
);

const productName =
  typeof packageJson.productName === 'string' && packageJson.productName.trim()
    ? packageJson.productName.trim()
    : 'HybridClaw';
const version =
  typeof packageJson.version === 'string' && packageJson.version.trim()
    ? packageJson.version.trim()
    : '0.0.0';

const releaseEntries = await fs.readdir(releaseDir, { withFileTypes: true });
const macBuildDirs = releaseEntries
  .filter((entry) => entry.isDirectory() && entry.name.startsWith('mac-'))
  .map((entry) => entry.name)
  .sort();

if (macBuildDirs.length === 0) {
  throw new Error(
    `No packaged mac app was found in ${releaseDir}. Run electron-builder --mac dir first.`,
  );
}

for (const buildDirName of macBuildDirs) {
  const arch = buildDirName.slice('mac-'.length);
  const appPath = path.join(releaseDir, buildDirName, `${productName}.app`);
  await fs.access(appPath);

  const targetPath = path.join(releaseDir, `${productName}-${version}-${arch}.dmg`);
  await fs.rm(targetPath, { force: true });

  const emitter = appdmg({
    basepath: desktopDir,
    target: targetPath,
    specification: {
      title: productName,
      icon: 'build/icon.icns',
      background: 'build/background.png',
      'icon-size': 116,
      window: {
        size: {
          width: 760,
          height: 480,
        },
      },
      contents: [
        {
          path: appPath,
          type: 'file',
          x: 194,
          y: 312,
        },
        {
          path: '/Applications',
          type: 'link',
          x: 566,
          y: 312,
        },
        {
          path: '.background',
          type: 'position',
          x: 1120,
          y: 120,
        },
        {
          path: '.VolumeIcon.icns',
          type: 'position',
          x: 1260,
          y: 120,
        },
        {
          path: '.DS_Store',
          type: 'position',
          x: 1120,
          y: 250,
        },
        {
          path: '.Trashes',
          type: 'position',
          x: 1260,
          y: 250,
        },
      ],
    },
  });

  const [event] = await Promise.race([
    once(emitter, 'finish').then(() => ['finish']),
    once(emitter, 'error').then(([error]) => {
      throw error;
    }),
  ]);

  if (event !== 'finish') {
    throw new Error(`DMG build did not finish for ${arch}.`);
  }

  console.log(`Built ${path.basename(targetPath)}`);
}
