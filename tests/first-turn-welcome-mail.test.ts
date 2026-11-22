import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.js';

const makeTempDir = useTempDir('hybridclaw-welcome-mail-');
useCleanMocks({
  resetModules: true,
  unmock: [
    '../src/infra/ipc.js',
    '../src/workspace.js',
    '../src/agents/agent-adopt.js',
    '../src/channels/message-tool-advertising.js',
  ],
});

const USER_MD = [
  '# USER.md - About Your Human',
  '',
  '- **Name:** Pat',
  '- **Email:** "pat@example.com"',
  '',
].join('\n');

interface Setup {
  onboarding?: boolean;
  adopted?: boolean;
  hadChats?: boolean;
  channels?: string[];
  user?: string;
}

async function load(setup: Setup = {}) {
  const workspace = makeTempDir();
  fs.writeFileSync(path.join(workspace, 'USER.md'), setup.user ?? USER_MD);
  vi.doMock('../src/infra/ipc.js', () => ({
    agentWorkspaceDir: () => workspace,
  }));
  vi.doMock('../src/workspace.js', () => ({
    onboardingTurnedOff: () => setup.onboarding === false,
    readUserMarkdown: (dir: string) =>
      fs.readFileSync(path.join(dir, 'USER.md'), 'utf-8'),
  }));
  vi.doMock('../src/agents/agent-adopt.js', () => ({
    isAdoptedAgent: () => setup.adopted === true,
    agentHasUserMessages: () => setup.hadChats === true,
  }));
  vi.doMock('../src/channels/message-tool-advertising.js', () => ({
    collectActiveMessageToolChannelKinds: () => setup.channels ?? ['email'],
  }));
  const mod = await import('../src/gateway/first-turn-welcome-mail.js');
  const readUser = () =>
    fs.readFileSync(path.join(workspace, 'USER.md'), 'utf-8');
  return { ...mod, readUser };
}

const TURN = {
  agentId: 'hy',
  source: 'gateway.chat',
  bootstrapFile: null,
  userContent: 'What is on today?',
};

function send(to: string, isError = false) {
  return {
    name: 'message',
    arguments: JSON.stringify({ action: 'send', to, subject: 'Hello' }),
    result: JSON.stringify({ ok: !isError, transport: 'email' }),
    isError,
  } as never;
}

describe('prepareFirstTurnWelcomeMail', () => {
  it('asks a non-onboarding agent to welcome its new user by email', async () => {
    const { prepareFirstTurnWelcomeMail } = await load({ onboarding: false });
    const prepared = prepareFirstTurnWelcomeMail(TURN);
    expect(prepared.userContent).toContain('to="pat@example.com"');
    expect(prepared.userContent.endsWith(TURN.userContent)).toBe(true);
  });

  it.each<[string, Setup, Partial<typeof TURN> & { dryRun?: boolean }]>([
    ['the agent onboards', { onboarding: true }, {}],
    ['the agent was adopted', { onboarding: false, adopted: true }, {}],
    ['no email channel', { onboarding: false, channels: ['slack'] }, {}],
    ['a scheduled job runs', { onboarding: false }, { source: 'scheduler' }],
    ['a dry run', { onboarding: false }, { dryRun: true }],
    ['a slash command', { onboarding: false }, { userContent: '/status' }],
    [
      'USER.md has no email',
      { onboarding: false, user: '# USER.md\n\n- **Name:** Pat\n' },
      {},
    ],
  ])('leaves the turn alone when %s', async (_name, setup, turn) => {
    const { prepareFirstTurnWelcomeMail } = await load(setup);
    const params = { ...TURN, ...turn };
    expect(prepareFirstTurnWelcomeMail(params).userContent).toBe(
      params.userContent,
    );
  });

  it('marks a user who already chatted as skipped instead of mailing', async () => {
    const { prepareFirstTurnWelcomeMail, readUser } = await load({
      onboarding: false,
      hadChats: true,
    });
    expect(prepareFirstTurnWelcomeMail(TURN).userContent).toBe(
      TURN.userContent,
    );
    expect(readUser()).toMatch(/## Welcome Message[\s\S]*Status:\*\* skipped/);
  });

  it.each([
    ['sent', [send('pat@example.com')], true, 'sent'],
    ['skipped', [], true, 'skipped'],
    ['skipped', [send('pat@example.com', true)], true, 'skipped'],
  ])('records %s and never asks again', async (_label, executions, ok, status) => {
    const { prepareFirstTurnWelcomeMail, readUser } = await load({
      onboarding: false,
    });
    prepareFirstTurnWelcomeMail(TURN).record(executions, ok);
    expect(readUser()).toContain(`- **Status:** ${status}`);
    expect(prepareFirstTurnWelcomeMail(TURN).userContent).toBe(
      TURN.userContent,
    );
  });

  it('keeps the offer open when the turn failed before sending', async () => {
    const { prepareFirstTurnWelcomeMail, readUser } = await load({
      onboarding: false,
    });
    prepareFirstTurnWelcomeMail(TURN).record([], false);
    expect(readUser()).not.toContain('Welcome Message');
  });
});
