import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';

describe.sequential('container read tool paths', () => {
  let cloudRoot = '';

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    if (cloudRoot) {
      fs.rmSync(cloudRoot, { recursive: true, force: true });
      cloudRoot = '';
    }
  });

  async function loadCloudReadRuntime(options?: {
    allowUploadedRoot?: boolean;
  }) {
    cloudRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-cloud-workspace-'),
    );
    const workspaceRoot = path.join(
      cloudRoot,
      '.data',
      'data',
      'agents',
      'anika',
      'workspace',
    );
    const uploadedRoot = path.join(
      cloudRoot,
      '.data',
      'data',
      'uploaded-media-cache',
    );
    fs.mkdirSync(workspaceRoot, { recursive: true });
    fs.mkdirSync(uploadedRoot, { recursive: true });

    vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', workspaceRoot);
    vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_DISPLAY_ROOT', cloudRoot);
    vi.stubEnv('HYBRIDCLAW_AGENT_UPLOADED_MEDIA_ROOT', uploadedRoot);
    if (options?.allowUploadedRoot) {
      vi.stubEnv(
        'HYBRIDCLAW_AGENT_ALLOWED_ROOTS',
        JSON.stringify([uploadedRoot]),
      );
    }
    vi.resetModules();

    const tools = await import('../container/src/tools.js');
    return { ...tools, uploadedRoot };
  }

  test('preserves an existing absolute path under an allowed root', async () => {
    const { executeTool, uploadedRoot } = await loadCloudReadRuntime({
      allowUploadedRoot: true,
    });
    const uploadedFile = path.join(uploadedRoot, '2026-08-21', 'note.txt');
    fs.mkdirSync(path.dirname(uploadedFile), { recursive: true });
    fs.writeFileSync(uploadedFile, 'allowed absolute path', 'utf8');

    const result = await executeTool(
      'read',
      JSON.stringify({ path: uploadedFile }),
    );

    expect(result).toBe('allowed absolute path');
  });

  test('preserves a current-turn upload path that shares the workspace display prefix', async () => {
    const { executeTool, setMediaContext, uploadedRoot } =
      await loadCloudReadRuntime();
    const uploadedFile = path.join(uploadedRoot, '2026-08-21', 'note.txt');
    fs.mkdirSync(path.dirname(uploadedFile), { recursive: true });
    fs.writeFileSync(uploadedFile, 'cloud attachment text', 'utf8');
    setMediaContext([
      {
        path: uploadedFile,
        url: '',
        originalUrl: '',
        mimeType: 'text/plain',
        sizeBytes: fs.statSync(uploadedFile).size,
        filename: 'note.txt',
      },
    ]);

    const result = await executeTool(
      'read',
      JSON.stringify({ path: uploadedFile }),
    );

    expect(result).toBe('cloud attachment text');
  });

  test('does not expose a different file from the uploaded-media cache', async () => {
    const { executeTool, setMediaContext, uploadedRoot } =
      await loadCloudReadRuntime();
    const currentFile = path.join(uploadedRoot, '2026-08-21', 'current.txt');
    const otherFile = path.join(uploadedRoot, '2026-08-21', 'other.txt');
    fs.mkdirSync(path.dirname(currentFile), { recursive: true });
    fs.writeFileSync(currentFile, 'current attachment', 'utf8');
    fs.writeFileSync(otherFile, 'other session data', 'utf8');
    setMediaContext([
      {
        path: currentFile,
        url: '',
        originalUrl: '',
        mimeType: 'text/plain',
        sizeBytes: fs.statSync(currentFile).size,
        filename: 'current.txt',
      },
    ]);

    const result = await executeTool(
      'read',
      JSON.stringify({ path: otherFile }),
    );

    expect(result).not.toContain('other session data');
    expect(result).toContain('File not found');
  });
});
