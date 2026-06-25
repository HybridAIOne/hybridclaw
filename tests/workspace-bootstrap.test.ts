import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.ts';

const originalCwd = process.cwd();

const makeTempDir = useTempDir();

function readWorkspaceState(workspaceDir: string): {
  bootstrapSeededAt?: string;
  onboardingCompletedAt?: string;
  hatchingTurnsWithoutMessage?: number;
} {
  const statePath = path.join(
    workspaceDir,
    '.hybridclaw',
    'workspace-state.json',
  );
  return JSON.parse(fs.readFileSync(statePath, 'utf-8')) as {
    bootstrapSeededAt?: string;
    onboardingCompletedAt?: string;
    hatchingTurnsWithoutMessage?: number;
  };
}

function completedUserMarkdown(): string {
  return [
    '# USER.md - About Your Human',
    '',
    '- **Name:** Ben',
    '- **What to call them:** Ben',
    '- **Email:** ben@example.com',
    '',
    '## Welcome Message',
    '',
    '- **Status:** drafted in chat',
    '- **Recipient:** ben@example.com',
    '- **Subject:** Your daily HybridClaw briefing helper',
    '- **Delivery:** not sent',
    '- **Last handled:** 2026-06-08',
    '',
  ].join('\n');
}

function completedUserMarkdownWithSentWelcome(): string {
  return [
    '# USER.md - About Your Human',
    '',
    '- **Name:** Ben',
    '- **What to call them:** Ben',
    '- **Email:** ben@example.com',
    '',
    '## Welcome Message',
    '',
    '- **Status:** sent',
    '- **Recipient:** ben@example.com',
    '- **Subject:** Welcome to HybridClaw',
    '- **Delivery:** email channel, 2026-06-09',
    '',
  ].join('\n');
}

function currentLocalDateStamp(): string {
  const now = new Date();
  const year = String(now.getFullYear());
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

useCleanMocks({
  cleanup: () => {
    process.chdir(originalCwd);
  },
  restoreAllMocks: false,
  resetModules: true,
  unstubAllEnvs: true,
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
      completedUserMarkdown(),
      'utf-8',
    );
    fs.unlinkSync(bootstrapPath);

    workspace.ensureBootstrapFiles('agent-test');

    expect(fs.existsSync(bootstrapPath)).toBe(false);
    const state = readWorkspaceState(workspaceDir);
    expect(state.bootstrapSeededAt).toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(state.onboardingCompletedAt).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  test('does not recreate BOOTSTRAP.md when a welcome message was sent', async () => {
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
      completedUserMarkdownWithSentWelcome(),
      'utf-8',
    );
    fs.unlinkSync(bootstrapPath);

    workspace.ensureBootstrapFiles('agent-test');

    expect(fs.existsSync(bootstrapPath)).toBe(false);
    const state = readWorkspaceState(workspaceDir);
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
      completedUserMarkdown(),
      'utf-8',
    );
    fs.unlinkSync(path.join(workspaceDir, 'BOOTSTRAP.md'));

    workspace.ensureBootstrapFiles('agent-test');

    const postHatchFiles = workspace.loadBootstrapFiles('agent-test');
    const postHatchAgents = postHatchFiles.find(
      (file) => file.name === 'AGENTS.md',
    );
    expect(postHatchAgents?.content).not.toContain('## First Run');
    expect(postHatchAgents?.content).not.toContain('hatching script');
    expect(postHatchAgents?.content).toContain('## Every Session');
  });

  test('seeds short hatching bootstrap instructions into fresh agent workspaces', async () => {
    const homeDir = makeTempDir('hybridclaw-home-');
    const unrelatedCwd = makeTempDir('hybridclaw-cwd-');
    vi.stubEnv('HOME', homeDir);
    process.chdir(unrelatedCwd);

    const workspace = await import('../src/workspace.js');
    const ipc = await import('../src/infra/ipc.js');

    workspace.ensureBootstrapFiles('agent-test');

    const workspaceDir = ipc.agentWorkspaceDir('agent-test');
    const userPath = path.join(workspaceDir, 'USER.md');
    const userMarkdown = fs.readFileSync(userPath, 'utf-8');
    expect(userMarkdown).toContain('## Welcome Message');
    expect(userMarkdown).toContain(
      '- **WhatsApp channel setup:** [Set up WhatsApp](/admin/channels#whatsapp)',
    );
    expect(userMarkdown).toContain(
      '- **Discord channel setup:** [Set up Discord](/admin/channels#discord)',
    );
    expect(userMarkdown).toContain(
      '- **Telegram channel setup:** [Set up Telegram](/admin/channels#telegram)',
    );
    const bootstrapPath = path.join(workspaceDir, 'BOOTSTRAP.md');
    const bootstrapMarkdown = fs.readFileSync(bootstrapPath, 'utf-8');
    expect(bootstrapMarkdown).toContain(
      'one of those first questions must ask for email',
    );
    expect(bootstrapMarkdown).toContain('Registration email');
    expect(bootstrapMarkdown).toContain('compact starter');
    expect(bootstrapMarkdown).toContain('choose 4 or 5 good questions');
    expect(bootstrapMarkdown).toContain('home automation');
    expect(bootstrapMarkdown).toContain('software platforms');
    expect(bootstrapMarkdown).toContain('The email question is mandatory');
    expect(bootstrapMarkdown).toContain(
      'they can add more context whenever they feel like',
    );
    expect(bootstrapMarkdown).toContain('Web chat is already working');
    expect(bootstrapMarkdown).toContain('/admin/channels#discord');
    expect(bootstrapMarkdown).toContain('/admin/channels#telegram');
    expect(bootstrapMarkdown).toContain(
      'Post these setup links as Markdown links in the hatching chat',
    );
    expect(bootstrapMarkdown).toContain(
      'Follow the short welcome email template',
    );
    expect(bootstrapMarkdown).toContain('Exactly 3 concrete first tasks');
    expect(bootstrapMarkdown).toContain('copy-paste prompt ideas');
    expect(bootstrapMarkdown).not.toContain('Optional channel setup:');

    const files = workspace.loadBootstrapFiles('agent-test');
    expect(files.some((file) => file.name === 'TASK_IDEAS.md')).toBe(false);
  });

  test('seeds BOOTSTRAP.md for explicit new-agent bootstrap even when workspace exists first', async () => {
    const homeDir = makeTempDir('hybridclaw-home-');
    const unrelatedCwd = makeTempDir('hybridclaw-cwd-');
    vi.stubEnv('HOME', homeDir);
    process.chdir(unrelatedCwd);

    const workspace = await import('../src/workspace.js');
    const ipc = await import('../src/infra/ipc.js');

    const workspaceDir = ipc.agentWorkspaceDir('agent-test');
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(
      path.join(workspaceDir, 'preexisting-note.md'),
      '# Preexisting Note\n',
      'utf-8',
    );

    const result = workspace.ensureBootstrapFiles('agent-test', {
      seedOneTimeBootstrap: true,
    });

    expect(result.workspaceInitialized).toBe(false);
    expect(fs.existsSync(path.join(workspaceDir, 'BOOTSTRAP.md'))).toBe(true);
    const state = readWorkspaceState(workspaceDir);
    expect(state.bootstrapSeededAt).toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(state.onboardingCompletedAt).toBeUndefined();
  });

  test('refreshes legacy default hatching bootstrap instructions', async () => {
    const homeDir = makeTempDir('hybridclaw-home-');
    const unrelatedCwd = makeTempDir('hybridclaw-cwd-');
    vi.stubEnv('HOME', homeDir);
    process.chdir(unrelatedCwd);

    const workspace = await import('../src/workspace.js');
    const ipc = await import('../src/infra/ipc.js');

    workspace.ensureBootstrapFiles('agent-test');

    const workspaceDir = ipc.agentWorkspaceDir('agent-test');
    const bootstrapPath = path.join(workspaceDir, 'BOOTSTRAP.md');
    fs.writeFileSync(
      bootstrapPath,
      [
        '# BOOTSTRAP.md - First Hatch',
        '',
        'Use the hatching task ideas guide in the docs website when available',
        '(`docs/content/guides/hatching-task-ideas.md` in the source tree). Do not recite',
        'it.',
        '',
      ].join('\n'),
      'utf-8',
    );

    workspace.ensureBootstrapFiles('agent-test');

    const refreshed = fs.readFileSync(bootstrapPath, 'utf-8');
    expect(refreshed).toContain('Welcome Message');
    expect(refreshed).toContain('successful `message` send tool call');
    expect(refreshed).not.toContain(
      'docs/content/guides/hatching-task-ideas.md',
    );
  });

  test("loads today's daily memory note into bootstrap context when present", async () => {
    const homeDir = makeTempDir('hybridclaw-home-');
    const unrelatedCwd = makeTempDir('hybridclaw-cwd-');
    vi.stubEnv('HOME', homeDir);
    process.chdir(unrelatedCwd);

    const workspace = await import('../src/workspace.js');
    const ipc = await import('../src/infra/ipc.js');

    workspace.ensureBootstrapFiles('agent-test');

    const workspaceDir = ipc.agentWorkspaceDir('agent-test');
    const dailyPath = path.join(
      workspaceDir,
      'memory',
      `${currentLocalDateStamp()}.md`,
    );
    fs.mkdirSync(path.dirname(dailyPath), { recursive: true });
    fs.writeFileSync(
      dailyPath,
      '# Daily Memory\n\n- Learned the deployment routine.\n',
      'utf-8',
    );

    const files = workspace.loadBootstrapFiles('agent-test');
    expect(files).toContainEqual({
      name: `memory/${currentLocalDateStamp()}.md`,
      content: '# Daily Memory\n\n- Learned the deployment routine.',
    });
  });

  test('omits the default HEARTBEAT.md from bootstrap context', async () => {
    const homeDir = makeTempDir('hybridclaw-home-');
    const unrelatedCwd = makeTempDir('hybridclaw-cwd-');
    vi.stubEnv('HOME', homeDir);
    process.chdir(unrelatedCwd);

    const workspace = await import('../src/workspace.js');
    const ipc = await import('../src/infra/ipc.js');

    workspace.ensureBootstrapFiles('agent-test');

    const workspaceDir = ipc.agentWorkspaceDir('agent-test');
    expect(fs.existsSync(path.join(workspaceDir, 'HEARTBEAT.md'))).toBe(true);

    const files = workspace.loadStaticBootstrapFiles('agent-test');
    expect(files.some((file) => file.name === 'HEARTBEAT.md')).toBe(false);
    expect(workspace.hasActionableHeartbeatFile('agent-test')).toBe(false);
  });

  test('does not treat missing or empty HEARTBEAT.md as actionable', async () => {
    const homeDir = makeTempDir('hybridclaw-home-');
    const unrelatedCwd = makeTempDir('hybridclaw-cwd-');
    vi.stubEnv('HOME', homeDir);
    process.chdir(unrelatedCwd);

    const workspace = await import('../src/workspace.js');
    const ipc = await import('../src/infra/ipc.js');

    workspace.ensureBootstrapFiles('agent-test');

    const workspaceDir = ipc.agentWorkspaceDir('agent-test');
    const heartbeatPath = path.join(workspaceDir, 'HEARTBEAT.md');
    fs.unlinkSync(heartbeatPath);
    expect(workspace.hasActionableHeartbeatFile('agent-test')).toBe(false);

    fs.writeFileSync(heartbeatPath, ' \n\t\n', 'utf-8');
    expect(workspace.hasActionableHeartbeatFile('agent-test')).toBe(false);
  });

  test('does not treat legacy empty HEARTBEAT.md defaults as actionable', async () => {
    const homeDir = makeTempDir('hybridclaw-home-');
    const unrelatedCwd = makeTempDir('hybridclaw-cwd-');
    vi.stubEnv('HOME', homeDir);
    process.chdir(unrelatedCwd);

    const workspace = await import('../src/workspace.js');
    const ipc = await import('../src/infra/ipc.js');

    workspace.ensureBootstrapFiles('agent-test');

    const workspaceDir = ipc.agentWorkspaceDir('agent-test');
    const heartbeatPath = path.join(workspaceDir, 'HEARTBEAT.md');
    fs.writeFileSync(
      heartbeatPath,
      '# HEARTBEAT.md\n\n# No recurring heartbeat tasks yet.\n',
      'utf-8',
    );

    const files = workspace.loadStaticBootstrapFiles('agent-test');
    expect(files.some((file) => file.name === 'HEARTBEAT.md')).toBe(false);
    expect(workspace.hasActionableHeartbeatFile('agent-test')).toBe(false);
  });

  test('loads customized HEARTBEAT.md into bootstrap context', async () => {
    const homeDir = makeTempDir('hybridclaw-home-');
    const unrelatedCwd = makeTempDir('hybridclaw-cwd-');
    vi.stubEnv('HOME', homeDir);
    process.chdir(unrelatedCwd);

    const workspace = await import('../src/workspace.js');
    const ipc = await import('../src/infra/ipc.js');

    workspace.ensureBootstrapFiles('agent-test');

    const workspaceDir = ipc.agentWorkspaceDir('agent-test');
    fs.writeFileSync(
      path.join(workspaceDir, 'HEARTBEAT.md'),
      '# HEARTBEAT.md\n\n- Check whether the nightly import completed.\n',
      'utf-8',
    );

    const files = workspace.loadStaticBootstrapFiles('agent-test');
    expect(files).toContainEqual({
      name: 'HEARTBEAT.md',
      content:
        '# HEARTBEAT.md\n\n- Check whether the nightly import completed.',
    });
    expect(workspace.hasActionableHeartbeatFile('agent-test')).toBe(true);
  });

  test('keeps BOOTSTRAP.md until a deterministic completion signal', async () => {
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
      completedUserMarkdown(),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(workspaceDir, 'MEMORY.md'),
      '# MEMORY.md - Session Memory\n\n## Facts\n- Assistant name chosen: Nova.\n',
      'utf-8',
    );

    workspace.ensureBootstrapFiles('agent-test');

    expect(fs.existsSync(bootstrapPath)).toBe(true);
    const state = readWorkspaceState(workspaceDir);
    expect(state.bootstrapSeededAt).toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(state.onboardingCompletedAt).toBeUndefined();
  });

  test('removes BOOTSTRAP.md after a successful hatching message send', async () => {
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
      completedUserMarkdown(),
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

    const completion = workspace.completeHatchingAfterMessageSend({
      agentId: 'agent-test',
      recipient: 'ben@example.com',
      subject: 'Welcome',
    });

    expect(completion).toMatchObject({
      completed: true,
      reason: 'message sent',
    });
    expect(fs.existsSync(bootstrapPath)).toBe(false);
    const state = readWorkspaceState(workspaceDir);
    expect(state.bootstrapSeededAt).toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(state.onboardingCompletedAt).toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(state.hatchingTurnsWithoutMessage).toBe(0);
  });

  test('keeps BOOTSTRAP.md while the welcome message is still pending', async () => {
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
      path.join(workspaceDir, 'USER.md'),
      [
        '# USER.md - About Your Human',
        '',
        '- **Name:** Ben',
        '- **What to call them:** Ben',
        '- **Email:** ben@example.com',
        '',
        '## Welcome Message',
        '',
        '- **Status:** pending',
        '- **Recipient:** ben@example.com',
        '- **Subject:** Welcome to HybridClaw',
        '- **Delivery:** not sent',
        '- **Last handled:**',
        '',
      ].join('\n'),
      'utf-8',
    );
    fs.mkdirSync(path.join(workspaceDir, '.session-transcripts'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(workspaceDir, '.session-transcripts', 'web.jsonl'),
      '{"role":"user","content":"You can email me at ben@example.com"}\n',
      'utf-8',
    );

    workspace.ensureBootstrapFiles('agent-test');

    expect(fs.existsSync(bootstrapPath)).toBe(true);
    const state = readWorkspaceState(workspaceDir);
    expect(state.bootstrapSeededAt).toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(state.onboardingCompletedAt).toBeUndefined();
  });

  test('keeps BOOTSTRAP.md while USER.md email is still pending', async () => {
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
      path.join(workspaceDir, 'USER.md'),
      '# USER.md - About Your Human\n\n- **Name:** Ben\n- **What to call them:** Ben\n- **Email:** (pending)\n',
      'utf-8',
    );
    fs.mkdirSync(path.join(workspaceDir, '.session-transcripts'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(workspaceDir, '.session-transcripts', 'web.jsonl'),
      '{"role":"user","content":"You can call me Ben"}\n',
      'utf-8',
    );

    workspace.ensureBootstrapFiles('agent-test');

    expect(fs.existsSync(bootstrapPath)).toBe(true);
    const state = readWorkspaceState(workspaceDir);
    expect(state.bootstrapSeededAt).toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(state.onboardingCompletedAt).toBeUndefined();
  });

  test('removes BOOTSTRAP.md after three hatching turns without a message send', async () => {
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
      path.join(workspaceDir, 'USER.md'),
      [
        '# USER.md - About Your Human',
        '',
        '- **Name:** Ben',
        '- **What to call them:** Ben',
        '- **Email:**',
        '',
        '## Welcome Message',
        '',
        '- **Status:** pending',
        '- **Recipient:**',
        '- **Subject:**',
        '- **Delivery:** not sent',
        '- **Last handled:**',
        '',
      ].join('\n'),
      'utf-8',
    );

    expect(
      workspace.recordHatchingTurnWithoutMessage({ agentId: 'agent-test' }),
    ).toMatchObject({
      completed: false,
      turnsWithoutMessage: 1,
    });
    expect(fs.existsSync(bootstrapPath)).toBe(true);

    expect(
      workspace.recordHatchingTurnWithoutMessage({ agentId: 'agent-test' }),
    ).toMatchObject({
      completed: false,
      turnsWithoutMessage: 2,
    });
    expect(fs.existsSync(bootstrapPath)).toBe(true);

    expect(
      workspace.recordHatchingTurnWithoutMessage({ agentId: 'agent-test' }),
    ).toMatchObject({
      completed: true,
      reason: 'no message sent after 3 hatching turns',
      turnsWithoutMessage: 3,
    });

    expect(fs.existsSync(bootstrapPath)).toBe(false);
    const state = readWorkspaceState(workspaceDir);
    expect(state.onboardingCompletedAt).toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(state.hatchingTurnsWithoutMessage).toBe(0);
  });

  test('symlinks workspace node_modules to the container app deps when absent', async () => {
    const homeDir = makeTempDir('hybridclaw-home-');
    const unrelatedCwd = makeTempDir('hybridclaw-cwd-');
    vi.stubEnv('HOME', homeDir);
    process.chdir(unrelatedCwd);

    const workspace = await import('../src/workspace.js');

    const wsDir = makeTempDir('hybridclaw-ws-');
    const appNodeModules = makeTempDir('hybridclaw-app-node_modules-');
    fs.mkdirSync(path.join(appNodeModules, 'pdf-lib'), { recursive: true });
    fs.writeFileSync(
      path.join(appNodeModules, 'pdf-lib', 'package.json'),
      JSON.stringify({ name: 'pdf-lib', version: '0.0.0-test' }),
      'utf-8',
    );

    workspace.ensureWorkspaceNodeModulesLink(wsDir, appNodeModules);

    const linkPath = path.join(wsDir, 'node_modules');
    const stat = fs.lstatSync(linkPath);
    expect(stat.isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(linkPath)).toBe(appNodeModules);
    // Sanity: the symlink resolves to the fake dep we staged.
    expect(fs.existsSync(path.join(linkPath, 'pdf-lib', 'package.json'))).toBe(
      true,
    );
  });

  test('leaves a pre-existing workspace node_modules directory untouched', async () => {
    const homeDir = makeTempDir('hybridclaw-home-');
    const unrelatedCwd = makeTempDir('hybridclaw-cwd-');
    vi.stubEnv('HOME', homeDir);
    process.chdir(unrelatedCwd);

    const workspace = await import('../src/workspace.js');

    const wsDir = makeTempDir('hybridclaw-ws-');
    const appNodeModules = makeTempDir('hybridclaw-app-node_modules-');
    fs.mkdirSync(path.join(appNodeModules, 'pdf-lib'), { recursive: true });

    // User-installed deps already present in the workspace.
    const userNodeModules = path.join(wsDir, 'node_modules');
    fs.mkdirSync(path.join(userNodeModules, 'left-pad'), { recursive: true });
    fs.writeFileSync(
      path.join(userNodeModules, 'left-pad', 'package.json'),
      JSON.stringify({ name: 'left-pad', version: '1.0.0' }),
      'utf-8',
    );

    workspace.ensureWorkspaceNodeModulesLink(wsDir, appNodeModules);

    const stat = fs.lstatSync(userNodeModules);
    expect(stat.isDirectory()).toBe(true);
    expect(stat.isSymbolicLink()).toBe(false);
    expect(
      fs.existsSync(path.join(userNodeModules, 'left-pad', 'package.json')),
    ).toBe(true);
    // App deps must NOT have leaked into the user's workspace.
    expect(fs.existsSync(path.join(userNodeModules, 'pdf-lib'))).toBe(false);
  });

  test('is a no-op when the container app node_modules source is absent', async () => {
    const homeDir = makeTempDir('hybridclaw-home-');
    const unrelatedCwd = makeTempDir('hybridclaw-cwd-');
    vi.stubEnv('HOME', homeDir);
    process.chdir(unrelatedCwd);

    const workspace = await import('../src/workspace.js');

    const wsDir = makeTempDir('hybridclaw-ws-');
    const missingSource = path.join(
      makeTempDir('hybridclaw-app-'),
      'does-not-exist',
    );

    workspace.ensureWorkspaceNodeModulesLink(wsDir, missingSource);

    expect(fs.existsSync(path.join(wsDir, 'node_modules'))).toBe(false);
  });

  test('can stage a dangling container node_modules symlink before docker launch', async () => {
    const homeDir = makeTempDir('hybridclaw-home-');
    const unrelatedCwd = makeTempDir('hybridclaw-cwd-');
    vi.stubEnv('HOME', homeDir);
    process.chdir(unrelatedCwd);

    const workspace = await import('../src/workspace.js');

    const wsDir = makeTempDir('hybridclaw-ws-');

    workspace.ensureWorkspaceNodeModulesLink(wsDir, '/app/node_modules', {
      allowMissingSource: true,
    });

    const linkPath = path.join(wsDir, 'node_modules');
    const stat = fs.lstatSync(linkPath);
    expect(stat.isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(linkPath)).toBe('/app/node_modules');
  });

  test('can replace a stale workspace node_modules symlink before docker launch', async () => {
    const homeDir = makeTempDir('hybridclaw-home-');
    const unrelatedCwd = makeTempDir('hybridclaw-cwd-');
    vi.stubEnv('HOME', homeDir);
    process.chdir(unrelatedCwd);

    const workspace = await import('../src/workspace.js');

    const wsDir = makeTempDir('hybridclaw-ws-');
    const linkPath = path.join(wsDir, 'node_modules');
    fs.symlinkSync('/Users/example/project/node_modules', linkPath, 'dir');

    workspace.ensureWorkspaceNodeModulesLink(wsDir, '/app/node_modules', {
      allowMissingSource: true,
      replaceExistingSymlink: true,
    });

    const stat = fs.lstatSync(linkPath);
    expect(stat.isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(linkPath)).toBe('/app/node_modules');
  });

  test('keeps a package-provided custom BOOTSTRAP.md on fresh install', async () => {
    const homeDir = makeTempDir('hybridclaw-home-');
    const unrelatedCwd = makeTempDir('hybridclaw-cwd-');
    vi.stubEnv('HOME', homeDir);
    process.chdir(unrelatedCwd);

    const workspace = await import('../src/workspace.js');
    const ipc = await import('../src/infra/ipc.js');

    workspace.ensureBootstrapFiles('agent-test');

    const workspaceDir = ipc.agentWorkspaceDir('agent-test');
    const bootstrapPath = path.join(workspaceDir, 'BOOTSTRAP.md');

    fs.writeFileSync(
      bootstrapPath,
      '# BOOTSTRAP.md - Persona Onboarding\n\nIntroduce yourself and onboard the user.\n',
      'utf-8',
    );
    fs.writeFileSync(
      path.join(workspaceDir, 'IDENTITY.md'),
      '# IDENTITY.md - Who Am I?\n\n- **Name:** Charly\n- **Creature:** GEO Specialist\n',
      'utf-8',
    );
    fs.writeFileSync(
      path.join(workspaceDir, 'USER.md'),
      '# USER.md - About Your Human\n\n- **Name:** Unknown until the user says otherwise\n',
      'utf-8',
    );
    fs.writeFileSync(
      path.join(workspaceDir, 'MEMORY.md'),
      '# MEMORY.md - Session Memory\n\n## Facts\n- Charly is optimized for GEO work.\n',
      'utf-8',
    );

    workspace.ensureBootstrapFiles('agent-test');

    expect(fs.existsSync(bootstrapPath)).toBe(true);
    expect(workspace.isBootstrapping('agent-test')).toBe(true);

    const state = readWorkspaceState(workspaceDir);
    expect(state.bootstrapSeededAt).toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(state.onboardingCompletedAt).toBeUndefined();
  });

  test('keeps a package-provided custom BOOTSTRAP.md until a deterministic completion signal', async () => {
    const homeDir = makeTempDir('hybridclaw-home-');
    const unrelatedCwd = makeTempDir('hybridclaw-cwd-');
    vi.stubEnv('HOME', homeDir);
    process.chdir(unrelatedCwd);

    const workspace = await import('../src/workspace.js');
    const ipc = await import('../src/infra/ipc.js');

    workspace.ensureBootstrapFiles('agent-test');

    const workspaceDir = ipc.agentWorkspaceDir('agent-test');
    const bootstrapPath = path.join(workspaceDir, 'BOOTSTRAP.md');

    fs.writeFileSync(
      bootstrapPath,
      '# BOOTSTRAP.md - Persona Onboarding\n\nIntroduce yourself as the GEO agent and onboard the user.\n',
      'utf-8',
    );
    fs.mkdirSync(path.join(workspaceDir, '.session-transcripts'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(workspaceDir, '.session-transcripts', 'web.jsonl'),
      '{"role":"assistant","content":"hi"}\n',
      'utf-8',
    );
    fs.writeFileSync(
      path.join(workspaceDir, 'USER.md'),
      completedUserMarkdown(),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(workspaceDir, 'MEMORY.md'),
      '# MEMORY.md - Session Memory\n\n## Facts\n- Ben runs HybridClaw.\n',
      'utf-8',
    );

    workspace.ensureBootstrapFiles('agent-test');

    expect(fs.existsSync(bootstrapPath)).toBe(true);
    const state = readWorkspaceState(workspaceDir);
    expect(state.bootstrapSeededAt).toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(state.onboardingCompletedAt).toBeUndefined();
  });
});
