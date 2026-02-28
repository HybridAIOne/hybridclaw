import { spawn } from 'node:child_process';

import { CONTAINER_IMAGE } from './config.js';

interface EnsureContainerImageOptions {
  commandName?: string;
  required?: boolean;
  cwd?: string;
}

function runCommand(command: string, args: string[], cwd?: string): Promise<{ code: number | null; err?: string }> {
  return new Promise((resolve) => {
    const proc = spawn(command, args, {
      cwd,
      stdio: 'pipe',
    });
    let err = '';
    proc.stderr.on('data', (chunk) => {
      err += chunk.toString('utf-8');
    });
    proc.on('error', (error) => {
      resolve({ code: null, err: (error as Error).message });
    });
    proc.on('close', (code) => {
      resolve({ code, err });
    });
  });
}

async function containerImageExists(imageName: string): Promise<boolean> {
  const result = await runCommand('docker', ['image', 'inspect', imageName]);
  return result.code === 0;
}

async function buildContainerImage(cwd: string): Promise<void> {
  const result = await runCommand('npm', ['run', 'build:container'], cwd);
  if (result.code !== 0) {
    throw new Error(result.err?.trim() || 'npm run build:container returned a non-zero exit code.');
  }
}

export async function ensureContainerImageReady(options: EnsureContainerImageOptions = {}): Promise<void> {
  const commandName = options.commandName || 'hybridclaw';
  const required = options.required !== false;
  const cwd = options.cwd || process.cwd();
  const imageName = CONTAINER_IMAGE;

  const exists = await containerImageExists(imageName);
  if (exists) return;

  const hint = [
    `${commandName}: Required container image '${imageName}' not found.`,
    'Run `npm run build:container` in the project root to build it.',
  ].join(' ');

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    if (required) {
      throw new Error(hint);
    }
    console.warn(`${commandName}: Skipping container image build check in non-interactive mode. ${hint}`);
    return;
  }

  console.log(`${commandName}: Container image '${imageName}' not found. Building now...`);
  try {
    await buildContainerImage(cwd);
    const built = await containerImageExists(imageName);
    if (!built) {
      throw new Error('Image still not available after build.');
    }
    console.log(`hybridclaw: Built container image '${imageName}'.`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!required) {
      console.warn(`${commandName}: Unable to build image automatically. ${hint}`);
      console.warn(`Details: ${message}`);
      return;
    }
    throw new Error(`${hint} Details: ${message}`);
  }
}
