import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { APP_VERSION, CONTAINER_IMAGE } from '../config/config.js';
import { DEFAULT_RUNTIME_HOME_DIR } from '../config/runtime-paths.js';

export type ContainerRebuildPolicy = 'if-stale' | 'always' | 'never';
export type ContainerImageAcquisitionMode =
  | 'pull-only'
  | 'pull-or-build'
  | 'build-only';

interface EnsureContainerImageOptions {
  commandName?: string;
  required?: boolean;
  cwd?: string;
}

export type DockerAccessIssueKind =
  | 'missing'
  | 'permission-denied'
  | 'daemon-unavailable';

export interface DockerAccessProbeResult {
  ready: boolean;
  kind: 'ready' | DockerAccessIssueKind;
  detail: string;
}

export class DockerAccessError extends Error {
  readonly kind: DockerAccessIssueKind;
  readonly detail: string;

  constructor(kind: DockerAccessIssueKind, detail: string, message: string) {
    super(message);
    this.name = 'DockerAccessError';
    this.kind = kind;
    this.detail = detail;
  }
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

function normalizeDockerDetail(
  raw: string | undefined,
  fallback: string,
): string {
  const lines = String(raw || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^errors pretty printing info\b/i.test(line));
  if (lines.length === 0) return fallback;

  const detail = lines
    .join(' ')
    .replace(/^ERROR:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  return detail || fallback;
}

function isDockerPermissionDenied(detail: string): boolean {
  return /permission denied|access denied|docker\.sock.*permission/i.test(
    detail,
  );
}

function buildDockerAccessMessage(
  commandName: string,
  issue: DockerAccessProbeResult,
): string {
  switch (issue.kind) {
    case 'missing':
      return `${commandName}: Install docker to use sandbox. Or start with --sandbox host.`;
    case 'permission-denied':
      return [
        `${commandName}: Docker is installed but the current user cannot access the Docker daemon (${issue.detail}).`,
        'Add this user to the `docker` group, start a new login shell, or set `container.sandboxMode` to `host`.',
      ].join(' ');
    case 'daemon-unavailable':
      return [
        `${commandName}: Docker daemon not ready (${issue.detail}).`,
        'Start Docker, or set `container.sandboxMode` to `host` to run without Docker.',
      ].join(' ');
    case 'ready':
      return `${commandName}: Docker is ready.`;
  }
}

export async function probeDockerAccess(): Promise<DockerAccessProbeResult> {
  const result = await runCommand('docker', ['info']);
  if (result.code === 0) {
    return {
      ready: true,
      kind: 'ready',
      detail: '',
    };
  }

  const detail = normalizeDockerDetail(
    result.err,
    'docker info returned a non-zero exit code.',
  );
  if (
    result.code === null &&
    /enoent|not found/i.test(normalizeDockerDetail(result.err, ''))
  ) {
    return {
      ready: false,
      kind: 'missing',
      detail,
    };
  }
  if (isDockerPermissionDenied(detail)) {
    return {
      ready: false,
      kind: 'permission-denied',
      detail,
    };
  }
  return {
    ready: false,
    kind: 'daemon-unavailable',
    detail,
  };
}

export async function containerImageExists(
  imageName: string,
): Promise<boolean> {
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
const STATE_ROOT_DIR = DEFAULT_RUNTIME_HOME_DIR;
const STATE_DIRNAME = 'container-image-state';
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

function isSourceCheckout(cwd: string): boolean {
  return fs.existsSync(path.join(cwd, '.git'));
}

function resolveContainerPullImages(imageName: string): string[] {
  const explicit = (process.env.HYBRIDCLAW_CONTAINER_PULL_IMAGE || '').trim();
  if (explicit) return [explicit];
  if (imageName.includes('/')) return [imageName];
  if (imageName !== DEFAULT_CONTAINER_IMAGE) return [];

  const candidates = [
    `${DEFAULT_DOCKERHUB_IMAGE}:v${APP_VERSION}`,
    `${DEFAULT_DOCKERHUB_IMAGE}:latest`,
    `${DEFAULT_GHCR_IMAGE}:v${APP_VERSION}`,
    `${DEFAULT_GHCR_IMAGE}:latest`,
  ];
  return Array.from(new Set(candidates));
}

export function resolveContainerImageAcquisitionMode(
  cwd: string,
  imageName: string,
): ContainerImageAcquisitionMode {
  const sourceCheckout = isSourceCheckout(cwd);
  if (!sourceCheckout) return 'pull-only';

  if ((process.env.HYBRIDCLAW_CONTAINER_PULL_IMAGE || '').trim()) {
    return 'pull-or-build';
  }
  if (imageName.includes('/')) {
    return 'pull-or-build';
  }
  if (imageName !== DEFAULT_CONTAINER_IMAGE) return 'build-only';

  // In a local checkout, published images can lag the working tree.
  return 'build-only';
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

async function ensureDockerAvailable(
  commandName: string,
  required: boolean,
): Promise<boolean> {
  const result = await probeDockerAccess();
  if (result.ready) return true;

  const message = buildDockerAccessMessage(commandName, result);
  if (required) {
    throw new DockerAccessError(
      result.kind as DockerAccessIssueKind,
      result.detail,
      message,
    );
  }
  console.warn(message);
  return false;
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
  return tryParseStateFile(stateFilePath(cwd), imageName);
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
    let reasonLoggedBeforeBuild = false;
    if (
      acquisitionMode === 'pull-or-build' ||
      acquisitionMode === 'pull-only'
    ) {
      const pullImages = resolveContainerPullImages(imageName);
      if (pullImages.length === 0) {
        throw new Error(
          [
            `No pullable container image source is configured for '${imageName}'.`,
            'Packaged installs only support pulling published runtime images.',
            'Set `container.image` to a registry-qualified image name or set `HYBRIDCLAW_CONTAINER_PULL_IMAGE`.',
          ].join(' '),
        );
      }
      console.log(`${commandName}: ${reason}`);
      reasonLoggedBeforeBuild = true;
      for (const pullImage of pullImages) {
        console.log(
          `${commandName}: Pulling container image '${pullImage}'...`,
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
      if (acquisitionMode === 'pull-only') {
        throw new Error('Published container image pull attempts failed.');
      }
    }

    const buildLogMessage = reasonLoggedBeforeBuild
      ? `${commandName}: Building container image '${imageName}'...`
      : `${commandName}: ${reason} Building container image '${imageName}'...`;
    console.log(buildLogMessage);
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
      const failurePrefix =
        acquisitionMode === 'pull-only'
          ? 'Unable to prepare image automatically.'
          : 'Unable to build image automatically.';
      console.warn(`${commandName}: ${failurePrefix} ${hint}`);
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
  const acquisitionMode = resolveContainerImageAcquisitionMode(cwd, imageName);
  const rebuildPolicy = resolveRebuildPolicy();
  const fingerprint = computeContainerFingerprint(cwd, imageName);
  const sourceCheckout = isSourceCheckout(cwd);
  const pullImages = resolveContainerPullImages(imageName);
  const packagedImageHint =
    pullImages.length > 0
      ? [
          'HybridClaw could not pull a published runtime image automatically.',
          'Check Docker connectivity and the published image tag, or set `container.sandboxMode` to `host` to run without Docker.',
        ].join(' ')
      : [
          'Packaged installs only support pulling published runtime images automatically.',
          'Set `container.image` to a registry-qualified image name or set `HYBRIDCLAW_CONTAINER_PULL_IMAGE`.',
        ].join(' ');

  if (!(await ensureDockerAvailable(commandName, required))) {
    return;
  }

  const exists = await containerImageExists(imageName);
  const missingImageHint = !sourceCheckout
    ? [
        `${commandName}: Required container image '${imageName}' not found.`,
        packagedImageHint,
      ].join(' ')
    : [
        `${commandName}: Required container image '${imageName}' not found.`,
        'Run `npm run build:container` in the project root to build it.',
        'HybridClaw also attempts to pull published images automatically before local build.',
      ].join(' ');
  const rebuildImageHint = !sourceCheckout
    ? [
        `${commandName}: Unable to refresh container image '${imageName}' automatically.`,
        packagedImageHint,
      ].join(' ')
    : [
        `${commandName}: Unable to rebuild container image '${imageName}' automatically.`,
        'Run `npm run build:container` in the project root to rebuild it manually.',
      ].join(' ');
  const refreshImageHint = !sourceCheckout
    ? [
        `${commandName}: Unable to refresh container image '${imageName}' automatically.`,
        packagedImageHint,
        'The existing image will be reused for now.',
      ].join(' ')
    : [
        `Run \`npm run build:container\` in the project root to refresh container image '${imageName}' manually.`,
        'The existing image will be reused for now.',
      ].join(' ');

  if (!exists) {
    await buildAndValidateImage({
      commandName,
      required,
      cwd,
      imageName,
      acquisitionMode,
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
      acquisitionMode,
      reason: "Container refresh policy is 'always'.",
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
  const staleImageReason = sourceCheckout
    ? 'Container sources changed since the last recorded build.'
    : 'A newer published container image may be available for this install.';

  await buildAndValidateImage({
    commandName,
    required,
    cwd,
    imageName,
    acquisitionMode,
    reason: staleImageReason,
    hint: refreshImageHint,
    fingerprint,
    fallbackToExistingImage: true,
  });
}
