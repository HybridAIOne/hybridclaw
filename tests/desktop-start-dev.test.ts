import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';
import { useTempDir } from './test-utils.js';

const run = promisify(execFile);
const makeTempDir = useTempDir();

function fixture(platform: string, exitCode: number, installFails = false) {
  const root = fs.realpathSync(makeTempDir('hybridclaw-desktop-start-'));
  const scripts = path.join(root, 'desktop', 'scripts');
  const electron = path.join(root, 'node_modules', 'electron');
  fs.mkdirSync(scripts, { recursive: true });
  fs.mkdirSync(electron, { recursive: true });
  fs.copyFileSync(
    'desktop/scripts/start-dev.mjs',
    path.join(scripts, 'start-dev.mjs'),
  );
  fs.writeFileSync(
    path.join(electron, 'index.js'),
    installFails
      ? "throw new Error('example installer failure');"
      : `const fs = require('node:fs');
const path = require('node:path');
const executable = path.join(__dirname, 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron');
fs.mkdirSync(path.dirname(executable), { recursive: true });
fs.writeFileSync(executable, 'example binary');
module.exports = executable;`,
  );
  const preload = path.join(root, 'preload.mjs');
  const childProcessModule = `
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
export function spawnSync(command, args) {
  if (command === '/bin/cp') fs.cpSync(args[1], args[2], { recursive: true });
  else if (command !== '/usr/libexec/PlistBuddy') throw new Error('Unexpected command');
  return { status: 0 };
}
export function spawn(command, args, options) {
  fs.writeFileSync(${JSON.stringify(path.join(root, 'launch.json'))}, JSON.stringify({ command, args, cwd: options.cwd }));
  const child = new EventEmitter();
  queueMicrotask(() => child.emit('exit', ${exitCode}, null));
  return child;
}`;
  fs.writeFileSync(
    preload,
    `import { registerHooks } from 'node:module';
Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} });
const replacement = ${JSON.stringify(`data:text/javascript,${encodeURIComponent(childProcessModule)}`)};
registerHooks({ resolve(specifier, context, nextResolve) {
  return nextResolve(specifier === 'node:child_process' ? replacement : specifier, context);
} });`,
  );
  return { root, preload, script: path.join(scripts, 'start-dev.mjs') };
}

test.each([
  ['darwin', 0],
  ['darwin', 7],
  ['linux', 0],
  ['linux', 7],
] as const)(
  'initializes Electron before first launch on %s and preserves exit %i',
  async (platform, exitCode) => {
    const { root, preload, script } = fixture(platform, exitCode);
    let status = 0;
    try {
      await run(process.execPath, ['--import', preload, script]);
    } catch (error) {
      status = (error as { code: number }).code;
    }
    expect(status).toBe(exitCode);
    const launch = JSON.parse(
      fs.readFileSync(path.join(root, 'launch.json'), 'utf8'),
    );
    if (platform === 'darwin') {
      const app = path.join(root, 'desktop', '.electron-dev', 'HybridClaw.app');
      expect(launch).toEqual({
        command: '/usr/bin/open',
        args: ['-W', '-n', app, '--args', path.join(root, 'desktop')],
      });
      expect(
        fs.readFileSync(
          path.join(app, 'Contents', 'MacOS', 'Electron'),
          'utf8',
        ),
      ).toBe('example binary');
    } else {
      expect(launch).toEqual({
        command: path.join(
          root,
          'node_modules',
          'electron',
          'dist',
          'Electron.app',
          'Contents',
          'MacOS',
          'Electron',
        ),
        args: ['.'],
        cwd: path.join(root, 'desktop'),
      });
    }
  },
);

test('stops before copying or launching when Electron initialization fails', async () => {
  const { root, preload, script } = fixture('darwin', 0, true);
  await expect(
    run(process.execPath, ['--import', preload, script]),
  ).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining('example installer failure'),
  });
  expect(fs.existsSync(path.join(root, 'desktop', '.electron-dev'))).toBe(
    false,
  );
  expect(fs.existsSync(path.join(root, 'launch.json'))).toBe(false);
});
