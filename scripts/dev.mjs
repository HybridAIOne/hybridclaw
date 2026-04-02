#!/usr/bin/env node

import { spawn } from 'node:child_process';

const children = new Set();
let shuttingDown = false;
let exitCode = 0;
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function spawnCommand(command, args) {
  const child = spawn(command, args, {
    stdio: 'inherit',
    env: process.env,
  });

  children.add(child);

  child.on('exit', (code, signal) => {
    children.delete(child);

    if (shuttingDown) {
      if (children.size === 0) {
        process.exit(exitCode);
      }
      return;
    }

    if (signal) {
      console.error(`[hybridclaw] ${command} exited from signal ${signal}`);
      exitCode = 1;
    } else {
      exitCode = code ?? 1;
    }

    shutdown();
  });

  child.on('error', (error) => {
    console.error(
      `[hybridclaw] failed to start ${command}: ${error instanceof Error ? error.message : String(error)}`,
    );
    exitCode = 1;
    shutdown();
  });

  return child;
}

function shutdown(signal = 'SIGTERM') {
  if (shuttingDown) return;
  shuttingDown = true;

  for (const child of children) {
    if (child.killed) continue;
    child.kill(signal);
  }

  if (children.size === 0) {
    process.exit(exitCode);
  }
}

spawnCommand(npmCommand, ['run', 'dev:gateway']);
spawnCommand(npmCommand, ['run', 'dev:console']);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    exitCode = 0;
    shutdown(signal);
  });
}
