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
});
