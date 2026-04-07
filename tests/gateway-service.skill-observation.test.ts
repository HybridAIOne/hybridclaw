import { expect, test, vi } from 'vitest';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { runAgentMock } = vi.hoisted(() => ({
  runAgentMock: vi.fn(),
}));

vi.mock('../src/agent/agent.js', () => ({
  runAgent: runAgentMock,
}));

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-gateway-skill-observation-',
  cleanup: () => {
    runAgentMock.mockReset();
  },
});

test('handleGatewayMessage records observations for implicitly activated single-skill runs', async () => {
  setupHome();

  const { initDatabase, getSkillObservationSummary } = await import(
    '../src/memory/db.ts'
  );
  const { updateRuntimeConfig } = await import(
    '../src/config/runtime-config.ts'
  );
  const { handleGatewayMessage } = await import(
    '../src/gateway/gateway-chat-service.ts'
  );

  initDatabase({ quiet: true });
  updateRuntimeConfig((draft) => {
    draft.adaptiveSkills.observationEnabled = true;
  });

  runAgentMock.mockResolvedValue({
    status: 'error',
    result: null,
    toolsUsed: ['bash'],
    toolExecutions: [
      {
        name: 'bash',
        arguments:
          '{"cmd":"bash skills/apple-music/scripts/search.sh \\"... But Seriously by Phil Collins\\""}',
        result: 'resolved the wrong album',
        durationMs: 24,
        isError: true,
      },
    ],
    error: 'resolved the wrong album',
  });

  const result = await handleGatewayMessage({
    sessionId: 'session-implicit-apple-music',
    guildId: null,
    channelId: 'web',
    userId: 'user-1',
    username: 'alice',
    content: 'Play ... But Seriously by Phil Collins',
    model: 'test-model',
    chatbotId: 'bot-1',
  });

  expect(result.status).toBe('error');
  expect(getSkillObservationSummary({ skillName: 'apple-music' })).toEqual([
    expect.objectContaining({
      skill_name: 'apple-music',
      total_executions: 1,
      failure_count: 1,
      tool_calls_attempted: 1,
      tool_calls_failed: 1,
    }),
  ]);
});

test('handleGatewayMessage does not attribute ambiguous read-only skill exploration', async () => {
  setupHome();

  const { initDatabase, getSkillObservationSummary } = await import(
    '../src/memory/db.ts'
  );
  const { updateRuntimeConfig } = await import(
    '../src/config/runtime-config.ts'
  );
  const { handleGatewayMessage } = await import(
    '../src/gateway/gateway-chat-service.ts'
  );

  initDatabase({ quiet: true });
  updateRuntimeConfig((draft) => {
    draft.adaptiveSkills.observationEnabled = true;
  });

  runAgentMock.mockResolvedValue({
    status: 'success',
    result: 'I explored a few skills.',
    toolsUsed: ['read'],
    toolExecutions: [
      {
        name: 'read',
        arguments: '{"path":"skills/apple-music/SKILL.md"}',
        result: 'ok',
        durationMs: 4,
      },
      {
        name: 'read',
        arguments: '{"path":"skills/pdf/SKILL.md"}',
        result: 'ok',
        durationMs: 4,
      },
    ],
  });

  const result = await handleGatewayMessage({
    sessionId: 'session-ambiguous-skill-read',
    guildId: null,
    channelId: 'web',
    userId: 'user-1',
    username: 'alice',
    content: 'Help with a file and some music.',
    model: 'test-model',
    chatbotId: 'bot-1',
  });

  expect(result.status).toBe('success');
  expect(getSkillObservationSummary({ skillName: 'apple-music' })).toEqual([]);
  expect(getSkillObservationSummary({ skillName: 'pdf' })).toEqual([]);
});

test('handleGatewayMessage does not request text streaming when no text callback is provided', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayMessage } = await import(
    '../src/gateway/gateway-chat-service.ts'
  );

  initDatabase({ quiet: true });

  runAgentMock.mockResolvedValue({
    status: 'success',
    result: 'done',
    toolsUsed: [],
    toolExecutions: [],
  });

  const result = await handleGatewayMessage({
    sessionId: 'session-no-stream',
    guildId: null,
    channelId: 'web',
    userId: 'user-1',
    username: 'alice',
    content: 'Say hi',
    model: 'test-model',
    chatbotId: 'bot-1',
  });

  expect(result.status).toBe('success');
  expect(runAgentMock).toHaveBeenCalledTimes(1);
  expect(runAgentMock.mock.calls[0]?.[0]?.onTextDelta).toBeUndefined();
});

test('handleGatewayMessage can auto-approve tools for eval requests without enabling full-auto session mode', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayMessage } = await import(
    '../src/gateway/gateway-chat-service.ts'
  );

  initDatabase({ quiet: true });

  runAgentMock.mockResolvedValue({
    status: 'success',
    result: 'done',
    toolsUsed: ['write'],
    toolExecutions: [],
  });

  const result = await handleGatewayMessage({
    sessionId: 'session-eval-auto-approve',
    guildId: null,
    channelId: 'eval-terminal-bench-native',
    userId: 'terminal-bench-native',
    username: 'terminal-bench-native',
    content: 'Write the file.',
    model: 'test-model',
    chatbotId: 'bot-1',
    autoApproveTools: true,
    neverAutoApproveTools: [],
    promptMode: 'none',
    source: 'eval.terminal-bench.native',
  });

  expect(result.status).toBe('success');
  expect(runAgentMock).toHaveBeenCalledTimes(1);
  expect(runAgentMock.mock.calls[0]?.[0]?.fullAutoEnabled).toBe(true);
  expect(runAgentMock.mock.calls[0]?.[0]?.fullAutoNeverApproveTools).toEqual(
    [],
  );
  expect(
    runAgentMock.mock.calls[0]?.[0]?.skipContainerSystemPrompt,
  ).toBe(true);
  const messages = runAgentMock.mock.calls[0]?.[0]?.messages as
    | Array<{ content?: string }>
    | undefined;
  expect(messages?.[0]?.content || '').not.toContain(
    'FULLAUTO mode is active for this session.',
  );
});

test('setGatewayAdminSkillEnabled stores per-channel disabled skills separately', async () => {
  setupHome();

  const { getRuntimeConfig, updateRuntimeConfig } = await import(
    '../src/config/runtime-config.ts'
  );
  const { setGatewayAdminSkillEnabled } = await import(
    '../src/gateway/gateway-service.ts'
  );

  updateRuntimeConfig((draft) => {
    draft.skills.disabled = ['pdf'];
    draft.skills.channelDisabled = {
      discord: ['docx'],
    };
  });

  const result = setGatewayAdminSkillEnabled({
    name: 'pptx',
    enabled: false,
    channel: 'teams',
  });

  expect(getRuntimeConfig().skills.disabled).toEqual(['pdf']);
  expect(getRuntimeConfig().skills.channelDisabled).toEqual({
    discord: ['docx'],
    msteams: ['pptx'],
  });
  expect(result.disabled).toEqual(['pdf']);
  expect(result.channelDisabled).toEqual({
    discord: ['docx'],
    msteams: ['pptx'],
  });
});
