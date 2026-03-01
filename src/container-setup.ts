import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { CONTAINER_IMAGE } from './config.js';

export type ContainerRebuildPolicy = 'if-stale' | 'always' | 'never';

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

interface ContainerImageState {
  imageName: string;
  fingerprint: string;
  recordedAt: string;
}

const CONTAINER_FINGERPRINT_VERSION = 'v1';
const STATE_DIRNAME = '.hybridclaw';
const STATE_FILENAME = 'container-image-state.json';
const TRACKED_FILES = [
  'package.json',
  'container/Dockerfile',
  'container/package.json',
  'container/package-lock.json',
  'container/tsconfig.json',
];
const TRACKED_SOURCE_ROOT = 'container/src';

function normalizeRebuildPolicy(raw: string | undefined): ContainerRebuildPolicy {
  const value = (raw || '').trim().toLowerCase();
  if (value === 'always') return 'always';
  if (value === 'never') return 'never';
  return 'if-stale';
}

function resolveRebuildPolicy(): ContainerRebuildPolicy {
  return normalizeRebuildPolicy(
    process.env.HYBRIDCLAW_CONTAINER_REBUILD
      || process.env.HYBRIDCLAW_CONTAINER_REBUILD_POLICY,
  );
}

function stateFilePath(cwd: string): string {
  return path.join(cwd, STATE_DIRNAME, STATE_FILENAME);
}

function readContainerImageState(cwd: string, imageName: string): ContainerImageState | null {
  const file = stateFilePath(cwd);
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<ContainerImageState>;
    if (
      parsed
      && parsed.imageName === imageName
      && typeof parsed.fingerprint === 'string'
      && parsed.fingerprint.trim() !== ''
    ) {
      return {
        imageName: parsed.imageName,
        fingerprint: parsed.fingerprint,
        recordedAt: typeof parsed.recordedAt === 'string' ? parsed.recordedAt : '',
      };
    }
  } catch {
    // ignore invalid state, we'll regenerate it
  }
  return null;
}

function writeContainerImageState(cwd: string, state: ContainerImageState): void {
  const file = stateFilePath(cwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2) + '\n');
}

function collectFilesRecursive(root: string, out: string[]): void {
  if (!fs.existsSync(root)) return;
  const stat = fs.statSync(root);
  if (!stat.isDirectory()) return;

  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      collectFilesRecursive(fullPath, out);
      continue;
    }
    if (entry.isFile()) out.push(fullPath);
  }
}

function computeContainerFingerprint(cwd: string, imageName: string): string | null {
  try {
    const hash = createHash('sha256');
    hash.update(`fingerprint-version:${CONTAINER_FINGERPRINT_VERSION}\n`);
    hash.update(`image:${imageName}\n`);

    for (const rel of TRACKED_FILES) {
      const abs = path.join(cwd, rel);
      hash.update(`file:${rel}\n`);
      if (!fs.existsSync(abs)) {
        hash.update('missing\n');
        continue;
      }
      hash.update(fs.readFileSync(abs));
      hash.update('\n');
    }

    const sourceRoot = path.join(cwd, TRACKED_SOURCE_ROOT);
    const sourceFiles: string[] = [];
    collectFilesRecursive(sourceRoot, sourceFiles);
    sourceFiles.sort((a, b) => a.localeCompare(b));

    for (const fullPath of sourceFiles) {
      const rel = path.relative(cwd, fullPath).replace(/\\/g, '/');
      hash.update(`source:${rel}\n`);
      hash.update(fs.readFileSync(fullPath));
      hash.update('\n');
    }

    return hash.digest('hex');
  } catch {
    return null;
  }
}

function ensureInteractiveAutoBuild(commandName: string, required: boolean, reason: string, hint: string): boolean {
  if (process.stdin.isTTY && process.stdout.isTTY) return true;
  if (required) {
    throw new Error(`${hint} ${reason}`);
  }
  console.warn(`${commandName}: Skipping automatic container build in non-interactive mode. ${hint}`);
  return false;
}

async function buildAndValidateImage(params: {
  commandName: string;
  required: boolean;
  cwd: string;
  imageName: string;
  reason: string;
  hint: string;
  fingerprint: string | null;
}): Promise<void> {
  const { commandName, required, cwd, imageName, reason, hint, fingerprint } = params;
  if (!ensureInteractiveAutoBuild(commandName, required, reason, hint)) return;

  console.log(`${commandName}: ${reason} Building container image '${imageName}'...`);
  try {
    await buildContainerImage(cwd);
    const built = await containerImageExists(imageName);
    if (!built) {
      throw new Error('Image still not available after build.');
    }
    if (fingerprint) {
      writeContainerImageState(cwd, {
        imageName,
        fingerprint,
        recordedAt: new Date().toISOString(),
      });
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

export async function ensureContainerImageReady(options: EnsureContainerImageOptions = {}): Promise<void> {
  const commandName = options.commandName || 'hybridclaw';
  const required = options.required !== false;
  const cwd = options.cwd || process.cwd();
  const imageName = CONTAINER_IMAGE;
  const rebuildPolicy = resolveRebuildPolicy();
  const fingerprint = computeContainerFingerprint(cwd, imageName);

  const exists = await containerImageExists(imageName);
  const hint = [
    `${commandName}: Required container image '${imageName}' not found.`,
    'Run `npm run build:container` in the project root to build it.',
  ].join(' ');

  if (!exists) {
    await buildAndValidateImage({
      commandName,
      required,
      cwd,
      imageName,
      reason: "Container image not found.",
      hint,
      fingerprint,
    });
    return;
  }

  if (rebuildPolicy === 'never') {
    if (fingerprint && !readContainerImageState(cwd, imageName)) {
      writeContainerImageState(cwd, {
        imageName,
        fingerprint,
        recordedAt: new Date().toISOString(),
      });
    }
    return;
  }

  if (rebuildPolicy === 'always') {
    await buildAndValidateImage({
      commandName,
      required,
      cwd,
      imageName,
      reason: "Container rebuild policy is 'always'.",
      hint,
      fingerprint,
    });
    return;
  }

  if (!fingerprint) return;

  const state = readContainerImageState(cwd, imageName);
  if (!state) {
    writeContainerImageState(cwd, {
      imageName,
      fingerprint,
      recordedAt: new Date().toISOString(),
    });
    return;
  }
  if (state.fingerprint === fingerprint) return;

  await buildAndValidateImage({
    commandName,
    required,
    cwd,
    imageName,
    reason: 'Container sources changed since the last recorded build.',
    hint,
    fingerprint,
  });
}
