import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.ts';

const originalCwd = process.cwd();

const makeTempDir = useTempDir();

useCleanMocks({
  cleanup: () => {
    process.chdir(originalCwd);
  },
  restoreAllMocks: false,
  resetModules: true,
  unstubAllEnvs: true,
});

describe('instruction integrity', () => {
  test('seeds runtime copies from installed sources and detects drift', async () => {
    const homeDir = makeTempDir('hybridclaw-home-');
    const unrelatedCwd = makeTempDir('hybridclaw-cwd-');
    vi.stubEnv('HOME', homeDir);
    process.chdir(unrelatedCwd);

    const instructions = await import(
      '../src/security/instruction-integrity.js'
    );

    const initial = instructions.verifyInstructionIntegrity();
    expect(initial.ok).toBe(true);
    expect(initial.runtimeRoot).toBe(
      path.join(homeDir, '.hybridclaw', 'instructions'),
    );

    const trustModelPath =
      instructions.resolveRuntimeInstructionPath('TRUST_MODEL.md');
    expect(fs.existsSync(trustModelPath)).toBe(true);
    expect(instructions.INSTRUCTION_FILES).toEqual(['TRUST_MODEL.md']);

    fs.writeFileSync(trustModelPath, 'tampered\n', 'utf-8');

    const drifted = instructions.verifyInstructionIntegrity();
    expect(drifted.ok).toBe(false);
    expect(drifted.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'TRUST_MODEL.md',
          status: 'modified',
        }),
      ]),
    );

    const synced = instructions.syncRuntimeInstructionCopies();
    expect(synced.files['TRUST_MODEL.md']).toBeTruthy();

    const restored = instructions.verifyInstructionIntegrity();
    expect(restored.ok).toBe(true);
  });

  test('sync deletes the retired runtime SECURITY.md copy', async () => {
    const homeDir = makeTempDir('hybridclaw-home-');
    vi.stubEnv('HOME', homeDir);

    const instructions = await import(
      '../src/security/instruction-integrity.js'
    );
    const stalePath = path.join(
      instructions.INSTRUCTION_RUNTIME_DIR,
      'SECURITY.md',
    );
    fs.mkdirSync(instructions.INSTRUCTION_RUNTIME_DIR, { recursive: true });
    fs.writeFileSync(stalePath, 'stale\n', 'utf-8');

    const synced = instructions.syncRuntimeInstructionCopies();

    expect(fs.existsSync(stalePath)).toBe(false);
    expect(Object.keys(synced.files)).toEqual(['TRUST_MODEL.md']);
    expect(instructions.verifyInstructionIntegrity().ok).toBe(true);
  });

  test('workspace bootstrap templates resolve from install root instead of cwd', async () => {
    const homeDir = makeTempDir('hybridclaw-home-');
    const unrelatedCwd = makeTempDir('hybridclaw-cwd-');
    vi.stubEnv('HOME', homeDir);
    process.chdir(unrelatedCwd);

    const workspace = await import('../src/workspace.js');
    const ipc = await import('../src/infra/ipc.js');

    workspace.ensureBootstrapFiles('agent-test');

    const workspaceDir = ipc.agentWorkspaceDir('agent-test');
    const soulPath = path.join(workspaceDir, 'SOUL.md');
    const agentsPath = path.join(workspaceDir, 'AGENTS.md');

    expect(fs.existsSync(soulPath)).toBe(true);
    expect(fs.existsSync(agentsPath)).toBe(true);
    expect(fs.readFileSync(soulPath, 'utf-8')).toContain('# SOUL.md');
    expect(fs.readFileSync(agentsPath, 'utf-8')).toContain(
      '# AGENTS.md - Your Workspace',
    );
  });
});
