import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const config = vi.hoisted(() => ({ DATA_DIR: '', CONTAINER_BINDS: [] }));
vi.mock('../src/config/config.js', () => config);

import {
  buildSessionAttachmentsContext,
  stageSessionAttachments,
} from '../src/media/session-attachments.js';
import type { MediaContextItem } from '../src/types/container.js';

let root: string;
let workspace: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-attachments-'));
  config.DATA_DIR = path.join(root, 'data');
  workspace = path.join(root, 'workspace');
  await fs.mkdir(workspace);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function upload(name = 'invoice.pdf', content = 'first upload') {
  const cache = path.join(config.DATA_DIR, 'uploaded-media-cache');
  await fs.mkdir(cache, { recursive: true });
  const source = path.join(cache, name);
  await fs.writeFile(source, content);
  const media: MediaContextItem = {
    path: `/uploaded-media-cache/${name}`,
    filename: 'invoice.pdf',
    mimeType: 'application/pdf',
    sizeBytes: content.length,
    url: 'https://example.com/upload',
    originalUrl: 'https://example.com/upload',
  };
  return { source, media };
}

function stage(
  media: MediaContextItem[],
  sessionId = 'session-a',
  mode: 'host' | 'container' = 'container',
) {
  return stageSessionAttachments({
    sessionId,
    mode,
    workspaceRoot: workspace,
    media,
  });
}

function hostPath(runtimePath: string) {
  return runtimePath.replace(/^\/workspace\//, `${workspace}/`);
}

test('Docker paths become ordinary workspace files that survive cache deletion', async () => {
  const { source, media } = await upload();
  const staged = await stage([media]);
  expect(staged.directory).toMatch(/^\/workspace\/attachments\//);
  expect(staged.media[0].path).toContain(staged.directory);
  expect(await fs.readFile(hostPath(staged.media[0].path!), 'utf8')).toBe(
    'first upload',
  );
  await fs.unlink(source);
  const followup = await stage([]);
  expect(followup.directory).toBe(staged.directory);
  expect(followup.media).toEqual([]);
  expect(await fs.readFile(hostPath(staged.media[0].path!), 'utf8')).toBe(
    'first upload',
  );
  expect(buildSessionAttachmentsContext(followup.directory)).not.toContain(
    'invoice.pdf',
  );
});

test('a first-turn workspace override can be created lazily', async () => {
  const { media } = await upload();
  workspace = path.join(root, 'new', 'workspace');
  const staged = await stage([media]);
  expect(await fs.readFile(hostPath(staged.media[0].path!), 'utf8')).toBe(
    'first upload',
  );
});

test('host mode uses host paths and separate uploads with equal filenames coexist', async () => {
  const first = await upload();
  first.media.path = first.source;
  const second = await upload('second.pdf', 'second upload');
  const staged = await stage([first.media, second.media], 'session-a', 'host');
  expect(staged.directory).toContain(workspace);
  expect(staged.media[0].path).not.toBe(staged.media[1].path);
  expect(path.basename(staged.media[0].path!)).toBe('invoice.pdf');
  expect(await fs.readFile(staged.media[1].path!, 'utf8')).toBe(
    'second upload',
  );
  await fs.writeFile(staged.media[0].path!, 'user edit');
  await stage([first.media], 'session-a', 'host');
  expect(await fs.readFile(staged.media[0].path!, 'utf8')).toBe('user edit');
});

test('different sessions and resets discover their own directories, including unsafe ids', async () => {
  const { media } = await upload();
  const first = await stage([media], '../session/a');
  expect((await stage([], '../session_a')).directory).toBeNull();
  const second = await stage([media], '../session_a');
  expect(first.directory).not.toBe(second.directory);
  expect((await stage([], 'new-session-instance')).directory).toBeNull();
  await fs.rm(hostPath(first.directory!), { recursive: true });
  expect((await stage([], '../session/a')).directory).toBeNull();
});

test('missing files, remote-only media, and paths outside allowed roots are not copied', async () => {
  const { media } = await upload();
  const outside = path.join(root, 'private.pdf');
  await fs.writeFile(outside, 'private');
  const items = [
    { ...media, path: outside },
    { ...media, path: '/uploaded-media-cache/../../private.pdf' },
    { ...media, path: '/uploaded-media-cache/missing.pdf' },
    { ...media, path: null },
  ];
  expect(await stage(items)).toEqual({ media: items, directory: null });
  await expect(
    fs.stat(path.join(workspace, 'attachments')),
  ).rejects.toMatchObject({ code: 'ENOENT' });
});

test('source symlinks cannot bring outside files into the container workspace', async () => {
  const { source, media } = await upload();
  const outside = path.join(root, 'private.pdf');
  await fs.writeFile(outside, 'private');
  await fs.unlink(source);
  await fs.symlink(outside, source);
  expect((await stage([media])).directory).toBeNull();
});

test('destination directory and file symlinks are rejected without modifying their targets', async () => {
  const { media } = await upload();
  const outside = path.join(root, 'outside');
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(workspace, 'attachments'));
  await expect(stage([media])).rejects.toThrow(
    'session_attachments_unsafe_directory',
  );
  expect(await fs.readdir(outside)).toEqual([]);
  await fs.unlink(path.join(workspace, 'attachments'));
  const staged = await stage([media]);
  const target = hostPath(staged.media[0].path!);
  await fs.unlink(target);
  const privateFile = path.join(outside, 'private.pdf');
  await fs.writeFile(privateFile, 'private');
  await fs.symlink(privateFile, target);
  await expect(stage([media])).rejects.toThrow(
    'session_attachments_unsafe_file',
  );
  expect(await fs.readFile(privateFile, 'utf8')).toBe('private');
  expect(await fs.readdir(path.dirname(target))).toEqual(['invoice.pdf']);
});

test('a directory hint does not trigger historical PDF extraction', async () => {
  const { injectPdfContextMessages } = await import(
    '../src/media/pdf-context.js'
  );
  const { media } = await upload();
  const staged = await stage([media]);
  const messages = [
    {
      role: 'user' as const,
      content: `Hello\n${buildSessionAttachmentsContext(staged.directory)}`,
    },
  ];
  expect(
    await injectPdfContextMessages({
      sessionId: 'session-a',
      workspaceRoot: workspace,
      messages,
      media: [],
    }),
  ).toEqual(messages);
});

test('current-turn PDFs are still extracted from their staged Docker paths', async () => {
  const { PDFDocument, StandardFonts } = await import('pdf-lib');
  const { injectPdfContextMessages } = await import(
    '../src/media/pdf-context.js'
  );
  const { source, media } = await upload();
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.addPage().drawText('Workspace attachment contents', { font });
  await fs.writeFile(source, await pdf.save());
  const staged = await stage([media]);
  const messages = await injectPdfContextMessages({
    sessionId: 'current-pdf',
    workspaceRoot: workspace,
    messages: [{ role: 'user', content: 'Read this PDF.' }],
    media: staged.media,
  });
  expect(
    messages.some(
      (message) =>
        message.role === 'system' &&
        String(message.content).includes('Workspace attachment contents'),
    ),
  ).toBe(true);
});

test('untrusted filenames cannot escape the upload directory', async () => {
  const { media } = await upload();
  media.filename = '../../outside.pdf';
  const staged = await stage([media]);
  expect(path.basename(staged.media[0].path!)).toBe('outside.pdf');
  expect(staged.media[0].path).toMatch(
    /^\/workspace\/attachments\/[a-f0-9]+\/[a-f0-9]+\/outside\.pdf$/,
  );
  await expect(
    fs.stat(path.join(workspace, 'outside.pdf')),
  ).rejects.toMatchObject({ code: 'ENOENT' });
});

test('failed copies leave no partially published file and can be retried', async () => {
  const { media } = await upload();
  const copy = vi
    .spyOn(fs, 'copyFile')
    .mockImplementationOnce(async (_source, target) => {
      await fs.writeFile(target, 'partial');
      throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    });
  try {
    await expect(stage([media])).rejects.toMatchObject({ code: 'ENOSPC' });
  } finally {
    copy.mockRestore();
  }
  const staged = await stage([media]);
  const target = hostPath(staged.media[0].path!);
  expect(await fs.readFile(target, 'utf8')).toBe('first upload');
  expect(await fs.readdir(path.dirname(target))).toEqual(['invoice.pdf']);
});
