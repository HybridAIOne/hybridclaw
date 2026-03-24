import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test } from 'vitest';

import {
  resolveAllowedHostMediaPath,
  type ValidatedMountAlias,
} from '../src/security/media-paths.js';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeFile(root: string, relativePath: string): string {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, 'audio-bytes', 'utf8');
  return filePath;
}

function canonicalPath(filePath: string): string {
  return fs.realpathSync(filePath);
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function buildParams(
  overrides: Partial<{
    rawPath: string;
    workspaceRoot: string;
    mediaCacheRoot: string;
    uploadedMediaRoot: string;
    mountAliases: ValidatedMountAlias[];
    allowHostAbsolutePaths: boolean;
  }> = {},
) {
  const workspaceRoot = overrides.workspaceRoot || makeTempDir('hc-workspace-');
  const mediaCacheRoot =
    overrides.mediaCacheRoot || makeTempDir('hc-discord-cache-');
  const uploadedMediaRoot =
    overrides.uploadedMediaRoot || makeTempDir('hc-uploaded-cache-');
  return {
    rawPath: overrides.rawPath || '',
    workspaceRoot,
    workspaceRootDisplay: '/workspace',
    mediaCacheRoot,
    mediaCacheRootDisplay: '/discord-media-cache',
    uploadedMediaRoot,
    uploadedMediaRootDisplay: '/uploaded-media-cache',
    mountAliases: overrides.mountAliases || [],
    managedTempDirPrefixes: ['hybridclaw-wa-'],
    allowHostAbsolutePaths: overrides.allowHostAbsolutePaths === true,
  };
}

test('allows workspace display paths under the workspace root', async () => {
  const workspaceRoot = makeTempDir('hc-workspace-');
  const filePath = writeFile(workspaceRoot, 'audio/voice-note.ogg');

  const resolved = await resolveAllowedHostMediaPath(
    buildParams({
      rawPath: '/workspace/audio/voice-note.ogg',
      workspaceRoot,
    }),
  );

  expect(resolved).toBe(canonicalPath(filePath));
});

test('allows validated mount alias display paths', async () => {
  const workspaceRoot = makeTempDir('hc-workspace-');
  const externalRoot = makeTempDir('hc-external-');
  const filePath = writeFile(externalRoot, 'clips/voice-note.ogg');

  const resolved = await resolveAllowedHostMediaPath(
    buildParams({
      rawPath: '/mounted/clips/voice-note.ogg',
      workspaceRoot,
      mountAliases: [
        {
          hostPath: externalRoot,
          containerPath: '/mounted',
        },
      ],
    }),
  );

  expect(resolved).toBe(canonicalPath(filePath));
});

test('blocks paths outside allowed roots when host absolute paths are disabled', async () => {
  const workspaceRoot = makeTempDir('hc-workspace-');
  const outsideRoot = makeTempDir('hc-outside-');
  const filePath = writeFile(outsideRoot, 'voice-note.ogg');

  const resolved = await resolveAllowedHostMediaPath(
    buildParams({
      rawPath: filePath,
      workspaceRoot,
    }),
  );

  expect(resolved).toBeNull();
});

test('allows managed temp media paths outside standard roots', async () => {
  const workspaceRoot = makeTempDir('hc-workspace-');
  const managedTempRoot = makeTempDir('hybridclaw-wa-');
  const filePath = writeFile(managedTempRoot, 'voice-note.ogg');

  const resolved = await resolveAllowedHostMediaPath(
    buildParams({
      rawPath: filePath,
      workspaceRoot,
    }),
  );

  expect(resolved).toBe(canonicalPath(filePath));
});

test('allows uploaded-media cache display paths', async () => {
  const workspaceRoot = makeTempDir('hc-workspace-');
  const uploadedMediaRoot = makeTempDir('hc-uploaded-cache-');
  const filePath = writeFile(uploadedMediaRoot, 'images/upload.png');

  const resolved = await resolveAllowedHostMediaPath(
    buildParams({
      rawPath: '/uploaded-media-cache/images/upload.png',
      workspaceRoot,
      uploadedMediaRoot,
    }),
  );

  expect(resolved).toBe(canonicalPath(filePath));
});

test('allows explicit host absolute paths when host mode is enabled', async () => {
  const workspaceRoot = makeTempDir('hc-workspace-');
  const outsideRoot = makeTempDir('hc-outside-');
  const filePath = writeFile(outsideRoot, 'voice-note.ogg');

  const resolved = await resolveAllowedHostMediaPath(
    buildParams({
      rawPath: filePath,
      workspaceRoot,
      allowHostAbsolutePaths: true,
    }),
  );

  expect(resolved).toBe(canonicalPath(filePath));
});
