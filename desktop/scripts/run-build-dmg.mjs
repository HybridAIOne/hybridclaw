import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const currentFile = fileURLToPath(import.meta.url);
const scriptsDir = path.dirname(currentFile);
const desktopDir = path.resolve(scriptsDir, '..');
const repoRoot = path.resolve(desktopDir, '..');
const electronBinary = path.join(
  repoRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'electron.cmd' : 'electron',
);

if (!fs.existsSync(electronBinary)) {
  console.error(`Electron binary not found at ${electronBinary}`);
  process.exit(1);
}

const child = spawn(electronBinary, ['scripts/build-dmg.mjs'], {
  cwd: desktopDir,
  stdio: 'inherit',
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
  },
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
