import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getExecutorSessionHealthSnapshots: vi.fn(() => []),
  getFullAutoRuntimeState: vi.fn(() => undefined),
  listAgents: vi.fn(() => [{ id: 'main', name: 'Main Agent' }]),
  getAllSessions: vi.fn(() => []),
  getRecentStructuredAuditForSession: vi.fn(() => []),
  getSkillObservations: vi.fn(() => []),
}));

vi.mock('../src/agent/executor.js', () => ({
  getExecutorSessionHealthSnapshots: mocks.getExecutorSessionHealthSnapshots,
}));

vi.mock('../src/agents/agent-registry.js', () => ({
  listAgents: mocks.listAgents,
}));

vi.mock('../src/memory/db.js', () => ({
  getAllSessions: mocks.getAllSessions,
  getRecentStructuredAuditForSession: mocks.getRecentStructuredAuditForSession,
  getSkillObservations: mocks.getSkillObservations,
}));

vi.mock('../src/gateway/fullauto-runtime.js', () => ({
  getFullAutoRuntimeState: mocks.getFullAutoRuntimeState,
}));

beforeEach(() => {
  mocks.getExecutorSessionHealthSnapshots.mockReturnValue([]);
  mocks.getFullAutoRuntimeState.mockReturnValue(undefined);
  mocks.listAgents.mockReturnValue([{ id: 'main', name: 'Main Agent' }]);
  mocks.getAllSessions.mockReturnValue([]);
  mocks.getRecentStructuredAuditForSession.mockReturnValue([]);
  mocks.getSkillObservations.mockReturnValue([]);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

test('reports green when process, recent skill, and error probes pass', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-04-29T12:00:00.000Z'));
  mocks.getExecutorSessionHealthSnapshots.mockReturnValue([
    {
      mode: 'host',
      sessionId: 'session-main',
      agentId: 'main',
      responsive: true,
      startedAt: Date.now() - 30_000,
      lastUsedAt: Date.now() - 1_000,
      readyForInputAt: Date.now() - 20_000,
      busy: false,
      terminalError: null,
      healthError: null,
    },
  ]);
  mocks.getSkillObservations.mockReturnValue([
    {
      id: 1,
      skill_name: 'development',
      agent_id: 'main',
      session_id: 'session-main',
      run_id: 'run-1',
      outcome: 'success',
      error_category: null,
      error_detail: null,
      tool_calls_attempted: 1,
      tool_calls_failed: 0,
      duration_ms: 1000,
      user_feedback: null,
      feedback_sentiment: null,
      created_at: '2026-04-29T11:55:00.000Z',
    },
  ]);

  const { getCoworkerLivenessSummary } = await import(
    '../src/gateway/coworker-liveness.js'
  );
  const summary = await getCoworkerLivenessSummary({ agentIds: ['main'] });

  expect(summary.probes[0]).toMatchObject({
    agentId: 'main',
    state: 'green',
    reasonCodes: ['all_checks_passing'],
    process: { code: 'process_responsive' },
    recentSkillRun: { code: 'recent_successful_skill_run' },
    escalatingErrors: { code: 'no_escalating_errors' },
  });
});

test('reports amber when no successful skill run has been observed', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-04-29T12:00:00.000Z'));

  const { getCoworkerLivenessSummary } = await import(
    '../src/gateway/coworker-liveness.js'
  );
  const summary = await getCoworkerLivenessSummary({ agentIds: ['main'] });

  expect(summary.probes[0]).toMatchObject({
    agentId: 'main',
    state: 'amber',
    reasonCodes: ['no_skill_runs_observed'],
    process: { code: 'process_not_running' },
  });
});

test('reports red when recent failures are escalating', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-04-29T12:00:00.000Z'));
  mocks.getSkillObservations.mockReturnValue(
    [1, 2, 3].map((id) => ({
      id,
      skill_name: 'development',
      agent_id: 'main',
      session_id: 'session-main',
      run_id: `run-${id}`,
      outcome: 'failure',
      error_category: 'tool_error',
      error_detail: 'tool failed',
      tool_calls_attempted: 1,
      tool_calls_failed: 1,
      duration_ms: 1000,
      user_feedback: null,
      feedback_sentiment: null,
      created_at: `2026-04-29T11:5${id}:00.000Z`,
    })),
  );

  const { getCoworkerLivenessSummary } = await import(
    '../src/gateway/coworker-liveness.js'
  );
  const summary = await getCoworkerLivenessSummary({ agentIds: ['main'] });

  expect(summary.probes[0]).toMatchObject({
    agentId: 'main',
    state: 'red',
    reasonCodes: [
      'no_successful_skill_run',
      'recent_skill_failures_escalating',
    ],
    escalatingErrors: {
      code: 'recent_skill_failures_escalating',
      count: 3,
    },
  });
});

test('reports red when an attached runtime fails the health ping', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-04-29T12:00:00.000Z'));
  mocks.getExecutorSessionHealthSnapshots.mockResolvedValue([
    {
      mode: 'container',
      sessionId: 'session-main',
      agentId: 'main',
      responsive: false,
      startedAt: Date.now() - 30_000,
      lastUsedAt: Date.now() - 1_000,
      readyForInputAt: Date.now() - 20_000,
      busy: false,
      terminalError: null,
      healthError: 'health probe timed out after 1000ms',
    },
  ]);
  mocks.getSkillObservations.mockReturnValue([
    {
      id: 1,
      skill_name: 'development',
      agent_id: 'main',
      session_id: 'session-main',
      run_id: 'run-1',
      outcome: 'success',
      error_category: null,
      error_detail: null,
      tool_calls_attempted: 1,
      tool_calls_failed: 0,
      duration_ms: 1000,
      user_feedback: null,
      feedback_sentiment: null,
      created_at: '2026-04-29T11:55:00.000Z',
    },
  ]);

  const { getCoworkerLivenessSummary } = await import(
    '../src/gateway/coworker-liveness.js'
  );
  const summary = await getCoworkerLivenessSummary({ agentIds: ['main'] });

  expect(summary.probes[0]).toMatchObject({
    agentId: 'main',
    state: 'red',
    reasonCodes: ['process_unresponsive'],
    process: {
      code: 'process_unresponsive',
      detail: 'health probe timed out after 1000ms',
      activeSessions: 1,
      responsiveSessions: 0,
      busySessions: 0,
    },
  });
});

test('loads skill observations once for all probed coworkers', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-04-29T12:00:00.000Z'));
  mocks.listAgents.mockReturnValue([
    { id: 'main', name: 'Main Agent' },
    { id: 'ops', name: 'Ops Agent' },
  ]);
  mocks.getExecutorSessionHealthSnapshots.mockResolvedValue([
    {
      mode: 'host',
      sessionId: 'session-ops',
      agentId: 'ops',
      responsive: true,
      startedAt: Date.now() - 30_000,
      lastUsedAt: Date.now() - 1_000,
      readyForInputAt: Date.now() - 20_000,
      busy: false,
      terminalError: null,
      healthError: null,
    },
  ]);
  mocks.getSkillObservations.mockReturnValue([
    {
      id: 1,
      skill_name: 'development',
      agent_id: 'ops',
      session_id: 'session-ops',
      run_id: 'run-1',
      outcome: 'success',
      error_category: null,
      error_detail: null,
      tool_calls_attempted: 1,
      tool_calls_failed: 0,
      duration_ms: 1000,
      user_feedback: null,
      feedback_sentiment: null,
      created_at: '2026-04-29T11:55:00.000Z',
    },
  ]);

  const { getCoworkerLivenessSummary } = await import(
    '../src/gateway/coworker-liveness.js'
  );
  const summary = await getCoworkerLivenessSummary({
    agentIds: ['main', 'ops'],
  });

  expect(mocks.getSkillObservations).toHaveBeenCalledTimes(1);
  expect(mocks.getSkillObservations).toHaveBeenCalledWith({ limit: 1_000 });
  expect(summary.probes.find((probe) => probe.agentId === 'ops')).toMatchObject(
    {
      recentSkillRun: { code: 'recent_successful_skill_run' },
    },
  );
});
