import fs from 'node:fs/promises';
import path from 'node:path';

import { expect, test } from 'vitest';
import {
  DISCORD_SEND_MEDIA_ROOT_DISPLAY,
  DISCORD_SEND_WORKSPACE_ROOT_DISPLAY,
  resolveDiscordLocalFileForSend,
} from '../src/channels/discord/send-files.js';
import { useTempDir } from './test-utils.ts';

const makeTempDir = useTempDir();

test('resolves relative file paths inside the session workspace', async () => {
  const workspaceRoot = await makeTempDir('hybridclaw-discord-workspace-');
  const mediaCacheRoot = await makeTempDir('hybridclaw-discord-media-');
  const expected = path.join(workspaceRoot, 'invoices', 'dashboard.html.png');
  await fs.mkdir(path.dirname(expected), { recursive: true });
  await fs.writeFile(expected, 'png');

  const resolved = resolveDiscordLocalFileForSend({
    filePath: 'invoices/dashboard.html.png',
    sessionWorkspaceRoot: workspaceRoot,
    mediaCacheRoot,
  });

  expect(resolved).toBe(expected);
});

test('maps display-root file paths to host workspace and media cache paths', async () => {
  const workspaceRoot = await makeTempDir('hybridclaw-discord-workspace-');
  const mediaCacheRoot = await makeTempDir('hybridclaw-discord-media-');
  const workspaceFile = path.join(
    workspaceRoot,
    '.browser-artifacts',
    'shot.png',
  );
  const mediaFile = path.join(mediaCacheRoot, '2026-03-10', 'sample.png');
  await fs.mkdir(path.dirname(workspaceFile), { recursive: true });
  await fs.mkdir(path.dirname(mediaFile), { recursive: true });
  await fs.writeFile(workspaceFile, 'png');
  await fs.writeFile(mediaFile, 'png');

  expect(
    resolveDiscordLocalFileForSend({
      filePath: `${DISCORD_SEND_WORKSPACE_ROOT_DISPLAY}/.browser-artifacts/shot.png`,
      sessionWorkspaceRoot: workspaceRoot,
      mediaCacheRoot,
    }),
  ).toBe(workspaceFile);
  expect(
    resolveDiscordLocalFileForSend({
      filePath: `${DISCORD_SEND_MEDIA_ROOT_DISPLAY}/2026-03-10/sample.png`,
      sessionWorkspaceRoot: workspaceRoot,
      mediaCacheRoot,
    }),
  ).toBe(mediaFile);
});

test('rejects traversal outside the session workspace', async () => {
  const workspaceRoot = await makeTempDir('hybridclaw-discord-workspace-');
  const mediaCacheRoot = await makeTempDir('hybridclaw-discord-media-');

  const resolved = resolveDiscordLocalFileForSend({
    filePath: '../secret.png',
    sessionWorkspaceRoot: workspaceRoot,
    mediaCacheRoot,
  });

  expect(resolved).toBeNull();
});

test('resolves media-cache files without a session workspace', async () => {
  const mediaCacheRoot = await makeTempDir('hybridclaw-discord-media-');
  const mediaFile = path.join(mediaCacheRoot, '2026-03-10', 'sample.png');
  await fs.mkdir(path.dirname(mediaFile), { recursive: true });
  await fs.writeFile(mediaFile, 'png');

  const resolved = resolveDiscordLocalFileForSend({
    filePath: `${DISCORD_SEND_MEDIA_ROOT_DISPLAY}/2026-03-10/sample.png`,
    mediaCacheRoot,
  });

  expect(resolved).toBe(mediaFile);
});
