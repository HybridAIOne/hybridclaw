import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

const originalCwd = process.cwd();
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function readWorkspaceState(workspaceDir: string): {
  bootstrapSeededAt?: string;
  onboardingCompletedAt?: string;
} {
  const statePath = path.join(
    workspaceDir,
    '.hybridclaw',
    'workspace-state.json',
  );
  return JSON.parse(fs.readFileSync(statePath, 'utf-8')) as {
    bootstrapSeededAt?: string;
    onboardingCompletedAt?: string;
  };
}

afterEach(() => {
  process.chdir(originalCwd);
  vi.resetModules();
  vi.unstubAllEnvs();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('workspace bootstrap lifecycle', () => {
  test('reports when a workspace is freshly initialized', async () => {
    const homeDir = makeTempDir('hybridclaw-home-');
    const unrelatedCwd = makeTempDir('hybridclaw-cwd-');
    vi.stubEnv('HOME', homeDir);
    process.chdir(unrelatedCwd);

    const workspace = await import('../src/workspace.js');
    const ipc = await import('../src/infra/ipc.js');

    const initial = workspace.ensureBootstrapFiles('agent-test');
    expect(initial.workspaceInitialized).toBe(true);
    expect(initial.workspacePath).toBe(ipc.agentWorkspaceDir('agent-test'));

    const second = workspace.ensureBootstrapFiles('agent-test');
    expect(second.workspaceInitialized).toBe(false);
    expect(second.workspacePath).toBe(initial.workspacePath);
  });

  test('does not recreate BOOTSTRAP.md after onboarding deletes it', async () => {
    const homeDir = makeTempDir('hybridclaw-home-');
    const unrelatedCwd = makeTempDir('hybridclaw-cwd-');
    vi.stubEnv('HOME', homeDir);
    process.chdir(unrelatedCwd);

    const workspace = await import('../src/workspace.js');
    const ipc = await import('../src/infra/ipc.js');

    workspace.ensureBootstrapFiles('agent-test');

    const workspaceDir = ipc.agentWorkspaceDir('agent-test');
    const bootstrapPath = path.join(workspaceDir, 'BOOTSTRAP.md');
    expect(fs.existsSync(bootstrapPath)).toBe(true);

    fs.writeFileSync(
      path.join(workspaceDir, 'IDENTITY.md'),
      '# IDENTITY.md - Who Am I?\n\n- **Name:** Nova\n',
      'utf-8',
    );
    fs.writeFileSync(
      path.join(workspaceDir, 'USER.md'),
      '# USER.md - About Your Human\n\n- **Name:** Ben\n',
      'utf-8',
    );
    fs.unlinkSync(bootstrapPath);

    workspace.ensureBootstrapFiles('agent-test');

    expect(fs.existsSync(bootstrapPath)).toBe(false);
    const state = readWorkspaceState(workspaceDir);
    expect(state.bootstrapSeededAt).toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(state.onboardingCompletedAt).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  test('omits the AGENTS first-run section once BOOTSTRAP.md is gone', async () => {
    const homeDir = makeTempDir('hybridclaw-home-');
    const unrelatedCwd = makeTempDir('hybridclaw-cwd-');
    vi.stubEnv('HOME', homeDir);
    process.chdir(unrelatedCwd);

    const workspace = await import('../src/workspace.js');
    const ipc = await import('../src/infra/ipc.js');

    workspace.ensureBootstrapFiles('agent-test');

    const preHatchFiles = workspace.loadBootstrapFiles('agent-test');
    const preHatchAgents = preHatchFiles.find(
      (file) => file.name === 'AGENTS.md',
    );
    expect(preHatchAgents?.content).toContain('## First Run');

    const workspaceDir = ipc.agentWorkspaceDir('agent-test');
    fs.writeFileSync(
      path.join(workspaceDir, 'IDENTITY.md'),
      '# IDENTITY.md - Who Am I?\n\n- **Name:** Nova\n',
      'utf-8',
    );
    fs.writeFileSync(
      path.join(workspaceDir, 'USER.md'),
      '# USER.md - About Your Human\n\n- **Name:** Ben\n',
      'utf-8',
    );
    fs.unlinkSync(path.join(workspaceDir, 'BOOTSTRAP.md'));

    workspace.ensureBootstrapFiles('agent-test');

    const postHatchFiles = workspace.loadBootstrapFiles('agent-test');
    const postHatchAgents = postHatchFiles.find(
      (file) => file.name === 'AGENTS.md',
    );
    expect(postHatchAgents?.content).not.toContain('## First Run');
    expect(postHatchAgents?.content).not.toContain('birth certificate');
    expect(postHatchAgents?.content).toContain('## Every Session');
  });

  test('supports light bootstrap mode for lightweight agent runs', async () => {
    const homeDir = makeTempDir('hybridclaw-home-');
    const unrelatedCwd = makeTempDir('hybridclaw-cwd-');
    vi.stubEnv('HOME', homeDir);
    process.chdir(unrelatedCwd);

    const workspace = await import('../src/workspace.js');

    workspace.ensureBootstrapFiles('agent-test');

    const lightFiles = workspace.loadBootstrapFiles('agent-test', {
      mode: 'light',
    });

    expect(lightFiles.map((file) => file.name).sort()).toEqual([
      'IDENTITY.md',
      'MEMORY.md',
      'SOUL.md',
      'USER.md',
    ]);
  });

  test('removes stale BOOTSTRAP.md when the workspace already looks completed', async () => {
    const homeDir = makeTempDir('hybridclaw-home-');
    const unrelatedCwd = makeTempDir('hybridclaw-cwd-');
    vi.stubEnv('HOME', homeDir);
    process.chdir(unrelatedCwd);

    const workspace = await import('../src/workspace.js');
    const ipc = await import('../src/infra/ipc.js');

    workspace.ensureBootstrapFiles('agent-test');

    const workspaceDir = ipc.agentWorkspaceDir('agent-test');
    const bootstrapPath = path.join(workspaceDir, 'BOOTSTRAP.md');
    expect(fs.existsSync(bootstrapPath)).toBe(true);

    fs.writeFileSync(
      path.join(workspaceDir, 'IDENTITY.md'),
      '# IDENTITY.md - Who Am I?\n\n- **Name:** Nova\n- **Creature:** ghost in the machine\n',
      'utf-8',
    );
    fs.writeFileSync(
      path.join(workspaceDir, 'USER.md'),
      '# USER.md - About Your Human\n\n- **Name:** Ben\n- **What to call them:** Ben\n',
      'utf-8',
    );
    fs.writeFileSync(
      path.join(workspaceDir, 'MEMORY.md'),
      '# MEMORY.md - Session Memory\n\n## Facts\n- Assistant name chosen: Nova.\n',
      'utf-8',
    );

    workspace.ensureBootstrapFiles('agent-test');

    expect(fs.existsSync(bootstrapPath)).toBe(false);
    const state = readWorkspaceState(workspaceDir);
    expect(state.bootstrapSeededAt).toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(state.onboardingCompletedAt).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  test('removes stale BOOTSTRAP.md after identity setup once transcripts exist', async () => {
    const homeDir = makeTempDir('hybridclaw-home-');
    const unrelatedCwd = makeTempDir('hybridclaw-cwd-');
    vi.stubEnv('HOME', homeDir);
    process.chdir(unrelatedCwd);

    const workspace = await import('../src/workspace.js');
    const ipc = await import('../src/infra/ipc.js');

    workspace.ensureBootstrapFiles('agent-test');

    const workspaceDir = ipc.agentWorkspaceDir('agent-test');
    const bootstrapPath = path.join(workspaceDir, 'BOOTSTRAP.md');
    expect(fs.existsSync(bootstrapPath)).toBe(true);

    fs.writeFileSync(
      path.join(workspaceDir, 'IDENTITY.md'),
      '# IDENTITY.md - Who Am I?\n\n- **Name:** Nova\n- **Creature:** ghost in the machine\n',
      'utf-8',
    );
    fs.writeFileSync(
      path.join(workspaceDir, 'USER.md'),
      '# USER.md - About Your Human\n\n- **Name:** Ben\n- **What to call them:** Ben\n',
      'utf-8',
    );
    fs.mkdirSync(path.join(workspaceDir, '.session-transcripts'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(workspaceDir, '.session-transcripts', 'tui.jsonl'),
      '{"role":"user","content":"hello"}\n',
      'utf-8',
    );

    workspace.ensureBootstrapFiles('agent-test');

    expect(fs.existsSync(bootstrapPath)).toBe(false);
    const state = readWorkspaceState(workspaceDir);
    expect(state.bootstrapSeededAt).toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(state.onboardingCompletedAt).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });
});
