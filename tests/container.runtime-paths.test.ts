import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

describe.sequential('container runtime path aliases', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  test('maps configured host bind paths into the workspace root', async () => {
    vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', '/workspace');
    vi.stubEnv(
      'HYBRIDCLAW_AGENT_EXTRA_MOUNTS',
      JSON.stringify([
        {
          hostPaths: [
            '/Users/example/OneDrive - Example/Buchhaltung',
            '/Users/example/Library/CloudStorage/OneDrive-Example/Buchhaltung',
          ],
          containerPath: '/workspace/extra/buchhaltung',
          readonly: true,
        },
      ]),
    );

    const { resolveWorkspacePath, resolveWorkspaceGlobPattern } = await import(
      '../container/src/runtime-paths.ts'
    );

    expect(
      resolveWorkspacePath(
        '/Users/example/OneDrive - Example/Buchhaltung/Rechnung.pdf',
      ),
    ).toBe('/workspace/extra/buchhaltung/Rechnung.pdf');

    expect(
      resolveWorkspaceGlobPattern(
        '/Users/example/OneDrive - Example/Buchhaltung/**/*.pdf',
      ),
    ).toBe('/workspace/extra/buchhaltung/**/*.pdf');
  });

  test('allows managed WhatsApp temp media paths', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-wa-'));
    const tempFile = path.join(tempDir, 'voice-note.ogg');
    fs.writeFileSync(tempFile, 'audio');

    const { resolveMediaPath } = await import(
      '../container/src/runtime-paths.ts'
    );

    expect(resolveMediaPath(tempFile)).toBe(fs.realpathSync.native(tempFile));

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('resolves uploaded-media cache display paths', async () => {
    const { resolveMediaPath } = await import(
      '../container/src/runtime-paths.ts'
    );

    expect(
      resolveMediaPath('/uploaded-media-cache/2026-03-24/upload.pdf'),
    ).toBe('/uploaded-media-cache/2026-03-24/upload.pdf');
  });

  test('resolves absolute uploaded-media cache host paths when the runtime root is configured', async () => {
    const uploadedRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-uploaded-media-'),
    );
    const uploadedFile = path.join(uploadedRoot, '2026-03-24', 'upload.png');
    fs.mkdirSync(path.dirname(uploadedFile), { recursive: true });
    fs.writeFileSync(uploadedFile, 'image');

    vi.stubEnv('HYBRIDCLAW_AGENT_UPLOADED_MEDIA_ROOT', uploadedRoot);
    vi.resetModules();

    const { resolveMediaPath } = await import(
      '../container/src/runtime-paths.ts'
    );

    expect(resolveMediaPath(uploadedFile)).toBe(path.resolve(uploadedFile));

    fs.rmSync(uploadedRoot, { recursive: true, force: true });
  });
});
