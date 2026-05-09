import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from 'vitest';
import {
  resolveAllowedHostMediaPath,
  type ValidatedMountAlias,
} from '../src/security/media-paths.js';
import { useTempDir } from './test-utils.ts';

const makeTempDir = useTempDir();

function writeFile(root: string, relativePath: string): string {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, 'audio-bytes', 'utf8');
  return filePath;
}

function canonicalPath(filePath: string): string {
  return fs.realpathSync(filePath);
}

function buildParams(
  overrides: Partial<{
    rawPath: string;
    workspaceRoot: string;
    workspaceRootDisplay: string;
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
    workspaceRootDisplay: overrides.workspaceRootDisplay || '/workspace',
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

test('allows host absolute paths inside uploaded-media root that share workspace display prefix', async () => {
  // Repro for host-sandbox-mode: runtime path is the real host path
  // (e.g. /workspace/.data/data/uploaded-media-cache/foo.ogg) and happens to
  // share a leading segment with workspaceRootDisplay ('/workspace'). The
  // display-to-host resolver must not greedily reinterpret a real host path
  // as a workspace display URI.
  const sharedPrefix = makeTempDir('hc-shared-prefix-');
  const workspaceRoot = path.join(sharedPrefix, 'workspace');
  const uploadedMediaRoot = path.join(
    sharedPrefix,
    '.data',
    'data',
    'uploaded-media-cache',
  );
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(uploadedMediaRoot, { recursive: true });
  const filePath = writeFile(uploadedMediaRoot, '2026-05-07/voice-note.ogg');

  const resolved = await resolveAllowedHostMediaPath(
    buildParams({
      rawPath: filePath,
      workspaceRoot,
      // Display prefix shares an ancestor with uploadedMediaRoot — same pattern
      // as the real container where workspaceRootDisplay is '/workspace' and
      // uploadedMediaRoot is '/workspace/.data/data/uploaded-media-cache'.
      workspaceRootDisplay: sharedPrefix,
      uploadedMediaRoot,
      allowHostAbsolutePaths: true,
    }),
  );

  expect(resolved).toBe(canonicalPath(filePath));
});
