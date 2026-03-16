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
    '../src/gateway/gateway-service.ts'
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
    '../src/gateway/gateway-service.ts'
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
