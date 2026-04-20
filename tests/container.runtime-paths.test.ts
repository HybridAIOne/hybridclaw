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

  test('allows host-mode absolute paths under configured allowed roots', async () => {
    const workspaceRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-workspace-'),
    );
    const projectRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-project-'),
    );
    const targetFile = path.join(projectRoot, 'docs', 'index.html');
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });
    fs.writeFileSync(targetFile, '<html></html>');

    vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', workspaceRoot);
    vi.stubEnv('HYBRIDCLAW_AGENT_ALLOWED_ROOTS', JSON.stringify([projectRoot]));
    vi.resetModules();

    const { resolveWorkspacePath, resolveWorkspaceGlobPattern } = await import(
      '../container/src/runtime-paths.ts'
    );

    expect(resolveWorkspacePath(targetFile)).toBe(path.resolve(targetFile));
    expect(
      resolveWorkspaceGlobPattern(path.join(projectRoot, 'docs', '*.html')),
    ).toBe(path.join(projectRoot, 'docs', '*.html'));

    fs.rmSync(workspaceRoot, { recursive: true, force: true });
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  test('expands ~/ paths before resolving files under allowed host roots', async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-home-'));
    const workspaceRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-workspace-'),
    );
    const projectRoot = path.join(tempHome, 'src', 'hybridclaw');
    const targetFile = path.join(projectRoot, 'docs', 'index.html');
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });
    fs.writeFileSync(targetFile, '<html></html>');

    vi.stubEnv('HOME', tempHome);
    vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', workspaceRoot);
    vi.stubEnv(
      'HYBRIDCLAW_AGENT_ALLOWED_ROOTS',
      JSON.stringify(['~/src/hybridclaw']),
    );
    vi.resetModules();

    const { resolveWorkspacePath } = await import(
      '../container/src/runtime-paths.ts'
    );

    expect(resolveWorkspacePath('~/src/hybridclaw/docs/index.html')).toBe(
      path.resolve(targetFile),
    );

    fs.rmSync(workspaceRoot, { recursive: true, force: true });
    fs.rmSync(tempHome, { recursive: true, force: true });
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

  test('maps overridden /app display root into the actual workspace root', async () => {
    const workspaceRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-app-root-'),
    );
    vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', workspaceRoot);
    vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_DISPLAY_ROOT', '/app');
    vi.resetModules();

    const { resolveWorkspacePath, WORKSPACE_ROOT_DISPLAY } = await import(
      '../container/src/runtime-paths.ts'
    );

    expect(WORKSPACE_ROOT_DISPLAY).toBe('/app');
    expect(resolveWorkspacePath('/app/ars.R')).toBe(
      path.join(workspaceRoot, 'ars.R'),
    );
    expect(resolveWorkspacePath('app/ars.R')).toBe(
      path.join(workspaceRoot, 'ars.R'),
    );
    expect(resolveWorkspacePath('ars.R')).toBe(
      path.join(workspaceRoot, 'ars.R'),
    );

    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test('prefers real absolute workspace paths over the /workspace display alias', async () => {
    const workspaceRoot = '/workspace/.data/data/agents/main/workspace';
    vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', workspaceRoot);
    vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_DISPLAY_ROOT', '/workspace');
    vi.resetModules();

    const { resolveWorkspacePath } = await import(
      '../container/src/runtime-paths.ts'
    );

    expect(
      resolveWorkspacePath(
        '/workspace/.data/data/agents/main/workspace/output.pdf',
      ),
    ).toBe('/workspace/.data/data/agents/main/workspace/output.pdf');
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
