import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { APP_VERSION, CONTAINER_IMAGE } from '../config/config.js';

export type ContainerRebuildPolicy = 'if-stale' | 'always' | 'never';
export type ContainerImageAcquisitionMode = 'pull-or-build' | 'build-only';

interface EnsureContainerImageOptions {
  commandName?: string;
  required?: boolean;
  cwd?: string;
}

function runCommand(
  command: string,
  args: string[],
  cwd?: string,
  env?: NodeJS.ProcessEnv,
): Promise<{ code: number | null; err?: string }> {
  return new Promise((resolve) => {
    const proc = spawn(command, args, {
      cwd,
      env,
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

async function pullContainerImage(imageName: string): Promise<void> {
  const result = await runCommand('docker', ['pull', imageName]);
  if (result.code !== 0) {
    throw new Error(
      result.err?.trim() ||
        `docker pull ${imageName} returned a non-zero exit code.`,
    );
  }
}

async function tagContainerImage(
  source: string,
  target: string,
): Promise<void> {
  if (source === target) return;
  const result = await runCommand('docker', ['tag', source, target]);
  if (result.code !== 0) {
    throw new Error(
      result.err?.trim() ||
        `docker tag ${source} ${target} returned a non-zero exit code.`,
    );
  }
}

async function buildContainerImage(
  cwd: string,
  imageName: string,
): Promise<void> {
  const result = await runCommand('npm', ['run', 'build:container'], cwd, {
    ...process.env,
    HYBRIDCLAW_CONTAINER_IMAGE: imageName,
  });
  if (result.code !== 0) {
    throw new Error(
      result.err?.trim() ||
        'npm run build:container returned a non-zero exit code.',
    );
  }
}

interface ContainerImageState {
  imageName: string;
  fingerprint: string;
  recordedAt: string;
}

const CONTAINER_FINGERPRINT_VERSION = 'v1';
const STATE_ROOT_DIR = path.join(os.homedir(), '.hybridclaw');
const STATE_DIRNAME = 'container-image-state';
const LEGACY_STATE_DIRNAME = '.hybridclaw';
const STATE_FILENAME = 'container-image-state.json';
const DEFAULT_CONTAINER_IMAGE = 'hybridclaw-agent';
const DEFAULT_DOCKERHUB_IMAGE = 'hybridaione/hybridclaw-agent';
const DEFAULT_GHCR_IMAGE = 'ghcr.io/hybridaione/hybridclaw-agent';
const TRACKED_FILES = [
  'package.json',
  'container/Dockerfile',
  'container/package.json',
  'container/package-lock.json',
  'container/tsconfig.json',
];
const TRACKED_SOURCE_ROOT = 'container/src';

function resolveContainerPullImages(imageName: string): string[] {
  const explicit = (process.env.HYBRIDCLAW_CONTAINER_PULL_IMAGE || '').trim();
  if (explicit) return [explicit];
  if (imageName.includes('/')) return [imageName];
  if (imageName !== DEFAULT_CONTAINER_IMAGE) return [];

  const candidates = [
    `${DEFAULT_GHCR_IMAGE}:v${APP_VERSION}`,
    `${DEFAULT_GHCR_IMAGE}:latest`,
    `${DEFAULT_DOCKERHUB_IMAGE}:v${APP_VERSION}`,
    `${DEFAULT_DOCKERHUB_IMAGE}:latest`,
  ];
  return Array.from(new Set(candidates));
}

export function resolveContainerImageAcquisitionMode(
  cwd: string,
  imageName: string,
): ContainerImageAcquisitionMode {
  if ((process.env.HYBRIDCLAW_CONTAINER_PULL_IMAGE || '').trim()) {
    return 'pull-or-build';
  }
  if (imageName.includes('/')) return 'pull-or-build';
  if (imageName !== DEFAULT_CONTAINER_IMAGE) return 'build-only';

  // In a local checkout, published images can lag the working tree.
  if (fs.existsSync(path.join(cwd, '.git'))) return 'build-only';
  return 'pull-or-build';
}

function normalizeRebuildPolicy(
  raw: string | undefined,
): ContainerRebuildPolicy {
  const value = (raw || '').trim().toLowerCase();
  if (value === 'always') return 'always';
  if (value === 'never') return 'never';
  return 'if-stale';
}

function resolveRebuildPolicy(): ContainerRebuildPolicy {
  return normalizeRebuildPolicy(
    process.env.HYBRIDCLAW_CONTAINER_REBUILD ||
      process.env.HYBRIDCLAW_CONTAINER_REBUILD_POLICY,
  );
}

function stateScopeKey(cwd: string): string {
  return createHash('sha256')
    .update(path.resolve(cwd))
    .digest('hex')
    .slice(0, 16);
}

function stateFilePath(cwd: string): string {
  return path.join(
    STATE_ROOT_DIR,
    STATE_DIRNAME,
    stateScopeKey(cwd),
    STATE_FILENAME,
  );
}

function legacyStateFilePath(cwd: string): string {
  return path.join(cwd, LEGACY_STATE_DIRNAME, STATE_FILENAME);
}

function tryParseStateFile(
  file: string,
  imageName: string,
): ContainerImageState | null {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(file, 'utf-8'),
    ) as Partial<ContainerImageState>;
    if (
      parsed &&
      parsed.imageName === imageName &&
      typeof parsed.fingerprint === 'string' &&
      parsed.fingerprint.trim() !== ''
    ) {
      return {
        imageName: parsed.imageName,
        fingerprint: parsed.fingerprint,
        recordedAt:
          typeof parsed.recordedAt === 'string' ? parsed.recordedAt : '',
      };
    }
  } catch {
    // ignore missing/invalid state
  }
  return null;
}

function readContainerImageState(
  cwd: string,
  imageName: string,
): ContainerImageState | null {
  const primaryState = tryParseStateFile(stateFilePath(cwd), imageName);
  if (primaryState) return primaryState;

  const legacyFile = legacyStateFilePath(cwd);
  const legacyState = tryParseStateFile(legacyFile, imageName);
  if (legacyState) {
    try {
      writeContainerImageState(cwd, legacyState);
      fs.rmSync(legacyFile, { force: true });
    } catch {
      // best-effort legacy state migration
    }
  }
  return legacyState;
}

function writeContainerImageState(
  cwd: string,
  state: ContainerImageState,
): void {
  const file = stateFilePath(cwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
}

function collectFilesRecursive(root: string, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      collectFilesRecursive(fullPath, out);
      continue;
    }
    if (entry.isFile()) out.push(fullPath);
  }
}

function computeContainerFingerprint(
  cwd: string,
  imageName: string,
): string | null {
  try {
    const hash = createHash('sha256');
    hash.update(`fingerprint-version:${CONTAINER_FINGERPRINT_VERSION}\n`);
    hash.update(`image:${imageName}\n`);
    if (fs.existsSync(path.join(cwd, '.git'))) {
      hash.update('local-checkout:true\n');
    }

    for (const rel of TRACKED_FILES) {
      const abs = path.join(cwd, rel);
      hash.update(`file:${rel}\n`);
      try {
        hash.update(fs.readFileSync(abs));
        hash.update('\n');
      } catch {
        hash.update('missing\n');
      }
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

function recordImageState(
  cwd: string,
  imageName: string,
  fingerprint: string | null,
): void {
  if (fingerprint) {
    writeContainerImageState(cwd, {
      imageName,
      fingerprint,
      recordedAt: new Date().toISOString(),
    });
  }
}

function ensureInteractiveAutoBuild(
  commandName: string,
  required: boolean,
  reason: string,
  hint: string,
): boolean {
  if (process.stdin.isTTY && process.stdout.isTTY) return true;
  if (required) {
    throw new Error(`${hint} ${reason}`);
  }
  console.warn(
    `${commandName}: Skipping automatic container build in non-interactive mode. ${hint}`,
  );
  return false;
}

async function buildAndValidateImage(params: {
  commandName: string;
  required: boolean;
  cwd: string;
  imageName: string;
  acquisitionMode: ContainerImageAcquisitionMode;
  reason: string;
  hint: string;
  fingerprint: string | null;
  fallbackToExistingImage?: boolean;
}): Promise<void> {
  const {
    commandName,
    required,
    cwd,
    imageName,
    acquisitionMode,
    reason,
    hint,
    fingerprint,
    fallbackToExistingImage = false,
  } = params;
  if (
    !ensureInteractiveAutoBuild(
      commandName,
      required && !fallbackToExistingImage,
      reason,
      hint,
    )
  ) {
    if (fallbackToExistingImage) {
      console.warn(
        `${commandName}: Continuing with existing container image '${imageName}'.`,
      );
    }
    return;
  }

  try {
    if (acquisitionMode === 'pull-or-build') {
      const pullImages = resolveContainerPullImages(imageName);
      for (const pullImage of pullImages) {
        console.log(
          `${commandName}: ${reason} Pulling container image '${pullImage}'...`,
        );
        try {
          await pullContainerImage(pullImage);
          await tagContainerImage(pullImage, imageName);
          recordImageState(cwd, imageName, fingerprint);
          if (pullImage === imageName) {
            console.log(
              `${commandName}: Pulled container image '${imageName}'.`,
            );
          } else {
            console.log(
              `${commandName}: Pulled container image '${pullImage}' and tagged it as '${imageName}'.`,
            );
          }
          return;
        } catch (err) {
          const pullMessage = err instanceof Error ? err.message : String(err);
          console.warn(`${commandName}: Unable to pull image '${pullImage}'.`);
          console.warn(`Details: ${pullMessage}`);
        }
      }
    }

    console.log(
      `${commandName}: ${reason} Building container image '${imageName}'...`,
    );
    await buildContainerImage(cwd, imageName);
    recordImageState(cwd, imageName, fingerprint);
    console.log(`${commandName}: Built container image '${imageName}'.`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (fallbackToExistingImage) {
      console.warn(
        `${commandName}: Unable to refresh image automatically. Continuing with existing container image '${imageName}'.`,
      );
      console.warn(`Details: ${message}`);
      return;
    }
    if (!required) {
      console.warn(
        `${commandName}: Unable to build image automatically. ${hint}`,
      );
      console.warn(`Details: ${message}`);
      return;
    }
    throw new Error(`${hint} Details: ${message}`);
  }
}

export async function ensureContainerImageReady(
  options: EnsureContainerImageOptions = {},
): Promise<void> {
  const commandName = options.commandName || 'hybridclaw';
  const required = options.required !== false;
  const cwd = options.cwd || process.cwd();
  const imageName = CONTAINER_IMAGE;
  const rebuildPolicy = resolveRebuildPolicy();
  const fingerprint = computeContainerFingerprint(cwd, imageName);

  const exists = await containerImageExists(imageName);
  const missingImageHint = [
    `${commandName}: Required container image '${imageName}' not found.`,
    'Run `npm run build:container` in the project root to build it.',
    'HybridClaw also attempts to pull published images automatically before local build.',
  ].join(' ');
  const rebuildImageHint = [
    `${commandName}: Unable to rebuild container image '${imageName}' automatically.`,
    'Run `npm run build:container` in the project root to rebuild it manually.',
  ].join(' ');
  const refreshImageHint = [
    `Run \`npm run build:container\` in the project root to refresh container image '${imageName}' manually.`,
    'The existing image will be reused for now.',
  ].join(' ');

  if (!exists) {
    await buildAndValidateImage({
      commandName,
      required,
      cwd,
      imageName,
      acquisitionMode: resolveContainerImageAcquisitionMode(cwd, imageName),
      reason: 'Container image not found.',
      hint: missingImageHint,
      fingerprint,
    });
    return;
  }

  if (rebuildPolicy === 'never') {
    if (fingerprint && !readContainerImageState(cwd, imageName)) {
      recordImageState(cwd, imageName, fingerprint);
    }
    return;
  }

  if (rebuildPolicy === 'always') {
    await buildAndValidateImage({
      commandName,
      required,
      cwd,
      imageName,
      acquisitionMode: 'build-only',
      reason: "Container rebuild policy is 'always'.",
      hint: rebuildImageHint,
      fingerprint,
    });
    return;
  }

  if (!fingerprint) return;

  const state = readContainerImageState(cwd, imageName);
  if (!state) {
    recordImageState(cwd, imageName, fingerprint);
    return;
  }
  if (state.fingerprint === fingerprint) return;

  await buildAndValidateImage({
    commandName,
    required,
    cwd,
    imageName,
    acquisitionMode: 'build-only',
    reason: 'Container sources changed since the last recorded build.',
    hint: refreshImageHint,
    fingerprint,
    fallbackToExistingImage: true,
  });
}
