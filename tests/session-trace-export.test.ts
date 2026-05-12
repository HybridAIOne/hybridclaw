import fs from 'node:fs';
import os from 'node:os';

import { expect, test } from 'vitest';

import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-session-trace-export-',
});

test('exports an opentraces/ATIF-compatible JSONL trace from stored session data', async () => {
  setupHome();

  const {
    getSessionById,
    getOrCreateSession,
    getSessionUsageTotals,
    initDatabase,
    recordUsageEvent,
    storeMessage,
    updateSessionModel,
  } = await import('../src/memory/db.ts');
  const { emitToolExecutionAuditEvents, recordAuditEvent } = await import(
    '../src/audit/audit-events.ts'
  );
  const { exportSessionTraceAtifJsonl } = await import(
    '../src/session/session-trace-export.ts'
  );

  initDatabase({ quiet: true });
  const session = getOrCreateSession(
    'session-trace-export',
    null,
    'channel-trace-export',
  );
  updateSessionModel(session.id, 'gpt-5-nano');
  storeMessage(session.id, 'user-1', 'alice', 'user', 'Fix the parser test');
  storeMessage(
    session.id,
    'assistant',
    null,
    'assistant',
    'I updated the parser test and verified the failure path.',
  );

  const runId = 'turn_trace_export_1';
  recordAuditEvent({
    sessionId: session.id,
    runId,
    event: {
      type: 'turn.start',
      turnIndex: 1,
      userInput: 'Fix the parser test',
      username: 'alice',
      source: 'gateway.chat',
    },
  });
  recordAuditEvent({
    sessionId: session.id,
    runId,
    event: {
      type: 'agent.start',
      provider: 'hybridai',
      model: 'gpt-5-nano',
      systemPrompt: 'You are a focused coding assistant.',
      promptMessages: 3,
      scheduledTaskCount: 0,
    },
  });
  emitToolExecutionAuditEvents({
    sessionId: session.id,
    runId,
    toolExecutions: [
      {
        name: 'bash',
        arguments: '{"command":"npm run test:unit -- parser"}',
        result: 'PASS parser.test.ts',
        durationMs: 3400,
        isError: false,
      },
    ],
  });
  recordAuditEvent({
    sessionId: session.id,
    runId,
    event: {
      type: 'model.usage',
      provider: 'hybridai',
      model: 'gpt-5-nano',
      promptTokens: 120,
      completionTokens: 45,
      totalTokens: 165,
      cacheReadTokens: 60,
      cacheWriteTokens: 15,
    },
  });
  recordAuditEvent({
    sessionId: session.id,
    runId,
    event: {
      type: 'turn.end',
      turnIndex: 1,
      finishReason: 'completed',
    },
  });
  recordAuditEvent({
    sessionId: session.id,
    runId,
    event: {
      type: 'session.end',
      reason: 'normal',
      stats: {
        userMessages: 1,
        assistantMessages: 1,
        toolCalls: 1,
        durationMs: 3800,
      },
    },
  });
  recordUsageEvent({
    sessionId: session.id,
    agentId: session.agent_id,
    model: 'gpt-5-nano',
    inputTokens: 120,
    outputTokens: 45,
    totalTokens: 165,
    toolCalls: 1,
    costUsd: 0.12,
  });
  const refreshedSession = getSessionById(session.id);
  if (!refreshedSession) {
    throw new Error('Expected refreshed session to exist');
  }

  const exported = await exportSessionTraceAtifJsonl({
    agentId: refreshedSession.agent_id,
    session: refreshedSession,
    messages: [
      {
        id: 1,
        session_id: session.id,
        user_id: 'user-1',
        username: 'alice',
        role: 'user',
        content: 'Fix the parser test',
        created_at: new Date().toISOString(),
      },
      {
        id: 2,
        session_id: session.id,
        user_id: 'assistant',
        username: null,
        role: 'assistant',
        content: 'I updated the parser test and verified the failure path.',
        created_at: new Date().toISOString(),
      },
    ],
    auditEntries: (
      await import('../src/memory/db.ts')
    ).getStructuredAuditForSession(session.id),
    usageTotals: getSessionUsageTotals(session.id),
  });

  expect(exported).not.toBeNull();
  expect(exported?.lineCount).toBe(1);
  expect(exported?.stepCount).toBe(2);
  expect(exported?.path).toContain('.trace-exports');
  expect(exported && fs.existsSync(exported.path)).toBe(true);

  const raw = fs.readFileSync(exported?.path || '', 'utf-8').trim();
  const record = JSON.parse(raw) as Record<string, unknown>;
  const steps = (record.steps as Array<Record<string, unknown>>) || [];
  expect(record.schema_version).toBe('0.1.0');
  expect(record.session_id).toBe(session.id);
  expect(record.task).toMatchObject({
    repository: null,
    base_commit: null,
  });
  expect(record.agent).toMatchObject({
    name: 'hybridclaw',
    model: 'hybridai/gpt-5-nano',
  });
  expect(record.environment).toMatchObject({
    vcs: {
      type: 'none',
      base_commit: null,
      branch: null,
      diff: null,
    },
    language_ecosystem: [],
  });
  expect(
    typeof (record.environment as Record<string, unknown>)?.os === 'string',
  ).toBe(true);
  expect(record.metadata.compatibility).toMatchObject({
    atif_version: '1.6',
  });
  expect(record.metadata.limitations).toEqual([
    'Tool observations use structured audit summaries because full tool stdout/stderr is not retained in the audit trail.',
    'Environment metadata fields such as os and shell are exported as runtime host information and are not anonymized.',
  ]);
  expect(record.metrics).toMatchObject({
    total_steps: 2,
    total_input_tokens: 120,
    total_output_tokens: 45,
  });
  expect(record.outcome).toMatchObject({
    success: true,
    signal_source: 'deterministic',
  });
  expect(record.content_hash).toMatch(/^[a-f0-9]{64}$/);
  expect(record.security).toEqual({
    scanned: true,
    flags_reviewed: 0,
    redactions_applied: 0,
    classifier_version: null,
  });
  const systemPrompts = record.system_prompts as Record<string, string>;
  const systemPromptHashes = Object.keys(systemPrompts);
  expect(systemPromptHashes).toHaveLength(1);
  expect(systemPrompts[systemPromptHashes[0] || '']).toBe(
    'You are a focused coding assistant.',
  );
  expect(record.tool_definitions).toEqual([{ name: 'bash' }]);
  expect(steps).toHaveLength(2);
  const firstStep = steps[0] || {};
  const secondStep = steps[1] || {};
  expect(firstStep).toMatchObject({
    step_index: 0,
    role: 'user',
    content: 'Fix the parser test',
  });
  expect(secondStep).toMatchObject({
    step_index: 1,
    role: 'agent',
    content: 'I updated the parser test and verified the failure path.',
    model: 'hybridai/gpt-5-nano',
    system_prompt_hash: systemPromptHashes[0],
    call_type: 'main',
    agent_role: 'main',
    token_usage: {
      input_tokens: 120,
      output_tokens: 45,
      cache_read_tokens: 60,
      cache_write_tokens: 15,
    },
  });
  expect(secondStep.tool_calls).toEqual([
    {
      tool_call_id: `${runId}:tool:1`,
      tool_name: 'bash',
      input: { command: 'npm run test:unit -- parser' },
      duration_ms: 3400,
    },
  ]);
  expect(secondStep.observations).toEqual([
    {
      source_call_id: `${runId}:tool:1`,
      content: 'PASS parser.test.ts',
      output_summary: 'PASS parser.test.ts',
      error: null,
    },
  ]);
});

test('trace export fills repository, dependencies, security, and attribution from workspace context', async () => {
  setupHome();

  const {
    getSessionById,
    getOrCreateSession,
    getSessionUsageTotals,
    initDatabase,
    recordUsageEvent,
    storeMessage,
  } = await import('../src/memory/db.ts');
  const { emitToolExecutionAuditEvents, recordAuditEvent } = await import(
    '../src/audit/audit-events.ts'
  );
  const { agentWorkspaceDir } = await import('../src/infra/ipc.ts');
  const { exportSessionTraceAtifJsonl } = await import(
    '../src/session/session-trace-export.ts'
  );

  initDatabase({ quiet: true });
  const session = getOrCreateSession(
    'session-trace-context',
    null,
    'channel-trace-context',
  );
  const workspaceDir = agentWorkspaceDir(session.agent_id);
  const sourceDir = `${workspaceDir}/src`;
  const parserPath = `${sourceDir}/parser.ts`;
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(
    `${workspaceDir}/requirements.txt`,
    'requests==2.32.3\n',
    'utf-8',
  );
  fs.writeFileSync(
    `${workspaceDir}/package.json`,
    JSON.stringify(
      {
        name: 'demo-workspace',
        repository: {
          type: 'git',
          url: 'git@github.com:acme/demo-workspace.git',
        },
        dependencies: {
          react: '^19.0.0',
        },
        devDependencies: {
          typescript: '^5.0.0',
          vitest: '^4.0.0',
        },
      },
      null,
      2,
    ),
    'utf-8',
  );
  fs.mkdirSync(`${workspaceDir}/.git`, { recursive: true });
  fs.writeFileSync(
    `${workspaceDir}/.git/config`,
    '[remote "origin"]\n\turl = git@github.com:acme/demo-workspace.git\n',
    'utf-8',
  );
  fs.writeFileSync(
    `${workspaceDir}/.git/HEAD`,
    'ref: refs/heads/main\n',
    'utf-8',
  );
  fs.mkdirSync(`${workspaceDir}/.git/refs/heads`, { recursive: true });
  fs.writeFileSync(
    `${workspaceDir}/.git/refs/heads/main`,
    '2e8d6a2d6f7f7c1c4d0b2f0a8d0d3f4f5a6b7c8d\n',
    'utf-8',
  );

  storeMessage(session.id, 'user-1', 'alice', 'user', 'Update parser.ts');
  storeMessage(session.id, 'assistant', null, 'assistant', 'Updated parser.ts');

  const runId = 'turn_trace_context_1';
  recordAuditEvent({
    sessionId: session.id,
    runId,
    event: {
      type: 'turn.start',
      turnIndex: 1,
      userInput: 'Update parser.ts',
      source: 'gateway.chat',
    },
  });
  recordAuditEvent({
    sessionId: session.id,
    runId,
    event: {
      type: 'agent.start',
      provider: 'hybridai',
      model: 'gpt-5-nano',
      systemPrompt: 'You are a focused coding assistant.',
      promptMessages: 2,
      scheduledTaskCount: 0,
    },
  });
  emitToolExecutionAuditEvents({
    sessionId: session.id,
    runId,
    toolExecutions: [
      {
        name: 'write',
        arguments: JSON.stringify({
          path: parserPath,
          content: 'export const parser = true;\nexport const updated = true;',
        }),
        result: 'Updated parser.ts',
        durationMs: 12,
        isError: false,
      },
    ],
  });
  recordAuditEvent({
    sessionId: session.id,
    runId,
    event: {
      type: 'turn.end',
      turnIndex: 1,
      finishReason: 'completed',
    },
  });
  recordUsageEvent({
    sessionId: session.id,
    agentId: session.agent_id,
    model: 'gpt-5-nano',
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
    toolCalls: 1,
    costUsd: 0.01,
  });

  const refreshedSession = getSessionById(session.id);
  if (!refreshedSession) {
    throw new Error('Expected refreshed session to exist');
  }

  const exported = await exportSessionTraceAtifJsonl({
    agentId: refreshedSession.agent_id,
    session: refreshedSession,
    messages: [
      {
        id: 1,
        session_id: session.id,
        user_id: 'user-1',
        username: 'alice',
        role: 'user',
        content: 'Update parser.ts',
        created_at: new Date().toISOString(),
      },
      {
        id: 2,
        session_id: session.id,
        user_id: 'assistant',
        username: null,
        role: 'assistant',
        content: 'Updated parser.ts',
        created_at: new Date().toISOString(),
      },
    ],
    auditEntries: (
      await import('../src/memory/db.ts')
    ).getStructuredAuditForSession(session.id),
    usageTotals: getSessionUsageTotals(session.id),
  });

  expect(exported).not.toBeNull();
  const raw = fs.readFileSync(exported?.path || '', 'utf-8').trim();
  const record = JSON.parse(raw) as Record<string, unknown>;
  expect(record.task).toMatchObject({
    repository: 'acme/demo-workspace',
    base_commit: '2e8d6a2d6f7f7c1c4d0b2f0a8d0d3f4f5a6b7c8d',
  });
  expect(record.environment).toMatchObject({
    vcs: {
      type: 'git',
      base_commit: '2e8d6a2d6f7f7c1c4d0b2f0a8d0d3f4f5a6b7c8d',
      branch: 'main',
      diff: null,
    },
    language_ecosystem: ['javascript', 'python', 'typescript'],
  });
  expect(record.dependencies).toEqual([
    'react',
    'requests',
    'typescript',
    'vitest',
  ]);
  expect(record.tool_definitions).toEqual([{ name: 'write' }]);
  expect(record.security).toEqual({
    scanned: true,
    flags_reviewed: 0,
    redactions_applied: 0,
    classifier_version: null,
  });
  expect(record.attribution).toEqual({
    version: '0.1.0',
    experimental: true,
    files: [
      {
        path: 'src/parser.ts',
        conversations: [
          {
            contributor: { type: 'ai' },
            url: 'opentraces://trace/step_1',
            ranges: [
              {
                start_line: 1,
                end_line: 2,
                content_hash: expect.stringMatching(/^[a-f0-9]{8}$/),
                confidence: 'high',
              },
            ],
          },
        ],
      },
    ],
  });
});

test('gateway export trace command writes the ATIF-compatible trace file', async () => {
  setupHome();

  const {
    getOrCreateSession,
    getSessionUsageTotals,
    getStructuredAuditForSession,
    initDatabase,
    recordUsageEvent,
    storeMessage,
  } = await import('../src/memory/db.ts');
  const { recordAuditEvent } = await import('../src/audit/audit-events.ts');

  initDatabase({ quiet: true });
  const session = getOrCreateSession(
    'session-trace-command',
    null,
    'channel-trace-command',
  );
  storeMessage(session.id, 'user-1', 'alice', 'user', 'Show a trace export');
  storeMessage(
    session.id,
    'assistant',
    null,
    'assistant',
    'Here is the exported trace.',
  );
  recordAuditEvent({
    sessionId: session.id,
    runId: 'turn_trace_command_1',
    event: {
      type: 'turn.start',
      turnIndex: 1,
      userInput: 'Show a trace export',
      source: 'gateway.chat',
    },
  });
  recordAuditEvent({
    sessionId: session.id,
    runId: 'turn_trace_command_1',
    event: {
      type: 'turn.end',
      turnIndex: 1,
      finishReason: 'completed',
    },
  });
  recordUsageEvent({
    sessionId: session.id,
    agentId: session.agent_id,
    model: 'gpt-5-nano',
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
    toolCalls: 0,
  });

  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );
  const result = await handleGatewayCommand({
    sessionId: session.id,
    guildId: null,
    channelId: session.channel_id,
    args: ['export', 'trace'],
  });

  expect(result.kind).toBe('info');
  if (result.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${result.kind}`);
  }
  expect(result.title).toBe('Trace Exported');
  expect(result.text).toContain('Steps: 2');
  const fileLine = result.text
    .split('\n')
    .find((line) => line.startsWith('File: '));
  expect(fileLine).toBeTruthy();
  const exportPath = fileLine?.slice('File: '.length) || '';
  expect(fs.existsSync(exportPath)).toBe(true);
  const raw = fs.readFileSync(exportPath, 'utf-8').trim();
  const record = JSON.parse(raw) as Record<string, unknown>;
  expect(record).toMatchObject({
    schema_version: '0.1.0',
    session_id: session.id,
  });

  expect(getStructuredAuditForSession(session.id)).toHaveLength(2);
  expect(getSessionUsageTotals(session.id).total_tokens).toBe(15);
});

test('trace export adds a fallback limitation when structured turn audit is unavailable', async () => {
  setupHome();

  const { getOrCreateSession, getSessionById, initDatabase, storeMessage } =
    await import('../src/memory/db.ts');
  const { exportSessionTraceAtifJsonl } = await import(
    '../src/session/session-trace-export.ts'
  );

  initDatabase({ quiet: true });
  const session = getOrCreateSession(
    'session-trace-fallback',
    null,
    'channel-trace-fallback',
  );
  storeMessage(session.id, 'user-1', 'alice', 'user', 'Fallback prompt');
  storeMessage(
    session.id,
    'assistant',
    null,
    'assistant',
    'Fallback response.',
  );

  const refreshedSession = getSessionById(session.id);
  if (!refreshedSession) {
    throw new Error('Expected refreshed session to exist');
  }

  const exported = await exportSessionTraceAtifJsonl({
    agentId: refreshedSession.agent_id,
    session: refreshedSession,
    messages: [
      {
        id: 1,
        session_id: session.id,
        user_id: 'user-1',
        username: 'alice',
        role: 'user',
        content: 'Fallback prompt',
        created_at: new Date().toISOString(),
      },
      {
        id: 2,
        session_id: session.id,
        user_id: 'assistant',
        username: null,
        role: 'assistant',
        content: 'Fallback response.',
        created_at: new Date().toISOString(),
      },
    ],
    auditEntries: [],
    usageTotals: {
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_tokens: 0,
      total_tool_calls: 0,
      total_cost_usd: 0,
      cost_per_call_usd: 0,
      call_count: 0,
    },
  });

  expect(exported).not.toBeNull();
  const raw = fs.readFileSync(exported?.path || '', 'utf-8').trim();
  const record = JSON.parse(raw) as Record<string, unknown>;

  expect(record.system_prompts).toEqual({});
  expect(record.metadata.limitations).toEqual([
    'Tool observations use structured audit summaries because full tool stdout/stderr is not retained in the audit trail.',
    'Environment metadata fields such as os and shell are exported as runtime host information and are not anonymized.',
    'Structured turn audit was unavailable, so steps were reconstructed directly from stored session messages.',
  ]);
});

test('trace export preserves multiline task descriptions', async () => {
  setupHome();

  const { getOrCreateSession, getSessionById, initDatabase, storeMessage } =
    await import('../src/memory/db.ts');
  const { exportSessionTraceAtifJsonl } = await import(
    '../src/session/session-trace-export.ts'
  );

  initDatabase({ quiet: true });
  const session = getOrCreateSession(
    'session-trace-multiline-task',
    null,
    'channel-trace-multiline-task',
  );
  const prompt = 'First paragraph.\n\nSecond paragraph with detail.';
  storeMessage(session.id, 'user-1', 'alice', 'user', prompt);
  storeMessage(
    session.id,
    'assistant',
    null,
    'assistant',
    'Handled the multiline request.',
  );

  const refreshedSession = getSessionById(session.id);
  if (!refreshedSession) {
    throw new Error('Expected refreshed session to exist');
  }

  const exported = await exportSessionTraceAtifJsonl({
    agentId: refreshedSession.agent_id,
    session: refreshedSession,
    messages: [
      {
        id: 1,
        session_id: session.id,
        user_id: 'user-1',
        username: 'alice',
        role: 'user',
        content: prompt,
        created_at: new Date().toISOString(),
      },
      {
        id: 2,
        session_id: session.id,
        user_id: 'assistant',
        username: null,
        role: 'assistant',
        content: 'Handled the multiline request.',
        created_at: new Date().toISOString(),
      },
    ],
    auditEntries: [],
    usageTotals: {
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_tokens: 0,
      total_tool_calls: 0,
      total_cost_usd: 0,
      cost_per_call_usd: 0,
      call_count: 0,
    },
  });

  expect(exported).not.toBeNull();
  const raw = fs.readFileSync(exported?.path || '', 'utf-8').trim();
  const record = JSON.parse(raw) as Record<string, unknown>;
  expect((record.task as Record<string, unknown>)?.description).toBe(prompt);
});

test('trace export enriches outcome with commit metadata from bash tool results', async () => {
  setupHome();

  const { getOrCreateSession, getSessionById, initDatabase, storeMessage } =
    await import('../src/memory/db.ts');
  const { emitToolExecutionAuditEvents, recordAuditEvent } = await import(
    '../src/audit/audit-events.ts'
  );
  const { exportSessionTraceAtifJsonl } = await import(
    '../src/session/session-trace-export.ts'
  );

  initDatabase({ quiet: true });
  const session = getOrCreateSession(
    'session-trace-commit',
    null,
    'channel-trace-commit',
  );
  storeMessage(session.id, 'user-1', 'alice', 'user', 'Commit the change');
  storeMessage(
    session.id,
    'assistant',
    null,
    'assistant',
    'Committed the fix.',
  );

  const runId = 'turn_trace_commit_1';
  recordAuditEvent({
    sessionId: session.id,
    runId,
    event: {
      type: 'turn.start',
      turnIndex: 1,
      userInput: 'Commit the change',
      source: 'gateway.chat',
    },
  });
  emitToolExecutionAuditEvents({
    sessionId: session.id,
    runId,
    toolExecutions: [
      {
        name: 'bash',
        arguments: JSON.stringify({ command: 'git commit -m "fix parser"' }),
        result: '[main abc1234] fix parser',
        durationMs: 250,
        isError: false,
      },
    ],
  });
  recordAuditEvent({
    sessionId: session.id,
    runId,
    event: {
      type: 'turn.end',
      turnIndex: 1,
      finishReason: 'completed',
    },
  });

  const refreshedSession = getSessionById(session.id);
  if (!refreshedSession) {
    throw new Error('Expected refreshed session to exist');
  }

  const exported = await exportSessionTraceAtifJsonl({
    agentId: refreshedSession.agent_id,
    session: refreshedSession,
    messages: [
      {
        id: 1,
        session_id: session.id,
        user_id: 'user-1',
        username: 'alice',
        role: 'user',
        content: 'Commit the change',
        created_at: new Date().toISOString(),
      },
      {
        id: 2,
        session_id: session.id,
        user_id: 'assistant',
        username: null,
        role: 'assistant',
        content: 'Committed the fix.',
        created_at: new Date().toISOString(),
      },
    ],
    auditEntries: (
      await import('../src/memory/db.ts')
    ).getStructuredAuditForSession(session.id),
    usageTotals: {
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_tokens: 0,
      total_tool_calls: 1,
      total_cost_usd: 0,
      cost_per_call_usd: 0,
      call_count: 0,
    },
  });

  expect(exported).not.toBeNull();
  const raw = fs.readFileSync(exported?.path || '', 'utf-8').trim();
  const record = JSON.parse(raw) as Record<string, unknown>;

  expect(record.outcome).toMatchObject({
    success: true,
    committed: true,
    commit_sha: 'abc1234',
    description: 'fix parser',
  });
});

test('gateway export trace all writes per-session ATIF-compatible trace files', async () => {
  setupHome();

  const { getOrCreateSession, initDatabase, recordUsageEvent, storeMessage } =
    await import('../src/memory/db.ts');
  const { recordAuditEvent } = await import('../src/audit/audit-events.ts');

  initDatabase({ quiet: true });

  const sessions = [
    getOrCreateSession('session-trace-all-1', null, 'channel-trace-all-1'),
    getOrCreateSession('session-trace-all-2', null, 'channel-trace-all-2'),
  ];

  for (const [index, session] of sessions.entries()) {
    storeMessage(
      session.id,
      'user-1',
      'alice',
      'user',
      `Export trace ${index + 1}`,
    );
    storeMessage(
      session.id,
      'assistant',
      null,
      'assistant',
      `Trace ${index + 1} exported`,
    );
    recordAuditEvent({
      sessionId: session.id,
      runId: `turn_trace_all_${index + 1}`,
      event: {
        type: 'turn.start',
        turnIndex: 1,
        userInput: `Export trace ${index + 1}`,
        source: 'gateway.chat',
      },
    });
    recordAuditEvent({
      sessionId: session.id,
      runId: `turn_trace_all_${index + 1}`,
      event: {
        type: 'turn.end',
        turnIndex: 1,
        finishReason: 'completed',
      },
    });
    recordUsageEvent({
      sessionId: session.id,
      agentId: session.agent_id,
      model: 'gpt-5-nano',
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      toolCalls: 0,
    });
  }

  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );
  const result = await handleGatewayCommand({
    sessionId: sessions[0].id,
    guildId: null,
    channelId: sessions[0].channel_id,
    args: ['export', 'trace', 'all'],
  });

  expect(result.kind).toBe('info');
  if (result.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${result.kind}`);
  }
  expect(result.title).toBe('Trace Exports Created');
  expect(result.text).toContain('Sessions exported: 2/2');
  expect(result.text).toContain('Total steps: 4');
  const fileLines = result.text
    .split('\n')
    .filter((line) => line.startsWith('- '));
  expect(fileLines).toHaveLength(2);
  for (const line of fileLines) {
    const filePath = line.slice(2);
    expect(fs.existsSync(filePath)).toBe(true);
    const raw = fs.readFileSync(filePath, 'utf-8').trim();
    const record = JSON.parse(raw) as Record<string, unknown>;
    expect(record.schema_version).toBe('0.1.0');
  }
});

test('trace export redacts secrets and anonymizes absolute-path usernames', async () => {
  setupHome();

  const { getOrCreateSession, getSessionById, initDatabase, storeMessage } =
    await import('../src/memory/db.ts');
  const { emitToolExecutionAuditEvents, recordAuditEvent } = await import(
    '../src/audit/audit-events.ts'
  );
  const { exportSessionTraceAtifJsonl } = await import(
    '../src/session/session-trace-export.ts'
  );

  initDatabase({ quiet: true });
  let localUsername = process.env.USER || process.env.USERNAME || '';
  if (!localUsername) {
    try {
      localUsername = os.userInfo().username;
    } catch {
      localUsername = 'alice';
    }
  }
  const highEntropySecret = 'Xk9mZr3pWq7vNt2sLf6yBh4jCe8gAa5d';
  const toolCommand = [
    `cat /Users/${localUsername}/work/project/.env`,
    `echo gho_abcdefghijklmnopqrstuvwxyz1234567890`,
    `echo npm_abcdefghijklmnopqrstuvwxyz123456`,
    `echo ~${localUsername}/docs`,
    `echo -Users-${localUsername}-src-project`,
    `echo C:\\Users\\${localUsername}\\Documents\\code.ts`,
    `echo C:/Users/${localUsername}/Documents/code.ts`,
    `echo /mnt/c/Users/${localUsername}/repo/app.ts`,
    `echo \\\\wsl.localhost\\Ubuntu\\home\\${localUsername}\\repo\\app.ts`,
    `echo //wsl.localhost/Ubuntu/home/${localUsername}/repo/app.ts`,
    `echo ${highEntropySecret}`,
  ].join(' && ');
  const session = getOrCreateSession(
    'session-trace-redaction',
    null,
    'channel-trace-redaction',
  );
  storeMessage(
    session.id,
    'user-1',
    'alice',
    'user',
    `Inspect /Users/${localUsername}/work/project/.env and token ghs_abcdefghijklmnopqrstuvwxyz1234567890 via ~${localUsername}/docs from -Users-${localUsername}-src-project and ${highEntropySecret}. Contact user@company.com at 203.0.113.42 or (555) 123-4567. German numbers: +49 170 3330160 and 089/4233232.`,
  );
  storeMessage(
    session.id,
    'assistant',
    null,
    'assistant',
    `I checked /home/${localUsername}/.config/app and found JWT eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYWRtaW4iLCJzY29wZSI6ImRldiJ9.signaturevalue123. Contact anna.meyer@example.com. SSN 123-45-6789. Card 4111 1111 1111 1111.`,
  );

  const runId = 'turn_trace_redaction_1';
  recordAuditEvent({
    sessionId: session.id,
    runId,
    event: {
      type: 'turn.start',
      turnIndex: 1,
      userInput: `Inspect /Users/${localUsername}/work/project/.env and token ghs_abcdefghijklmnopqrstuvwxyz1234567890 via ~${localUsername}/docs from -Users-${localUsername}-src-project and ${highEntropySecret}. Contact user@company.com at 203.0.113.42 or (555) 123-4567. German numbers: +49 170 3330160 and 089/4233232.`,
      username: 'alice',
      source: 'gateway.chat',
    },
  });
  recordAuditEvent({
    sessionId: session.id,
    runId,
    event: {
      type: 'agent.start',
      provider: 'hybridai',
      model: 'gpt-5-nano',
      systemPrompt:
        'You are a focused coding assistant. Email ops@example.com or call +491701234567 for escalations.',
      promptMessages: 3,
      scheduledTaskCount: 0,
    },
  });
  emitToolExecutionAuditEvents({
    sessionId: session.id,
    runId,
    toolExecutions: [
      {
        name: 'bash',
        arguments: JSON.stringify({ command: toolCommand }),
        result: `Webhook https://discord.com/api/webhooks/123456/abcdefghijklmnopqrstuvwxyz and token pypi-abcdefghijklmnopqrstuvwxyz123456 at C:/Users/${localUsername}/Documents/code.ts`,
        durationMs: 250,
        isError: false,
      },
    ],
  });
  recordAuditEvent({
    sessionId: session.id,
    runId,
    event: {
      type: 'turn.end',
      turnIndex: 1,
      finishReason: 'completed',
    },
  });

  const refreshedSession = getSessionById(session.id);
  if (!refreshedSession) {
    throw new Error('Expected refreshed session to exist');
  }

  const exported = await exportSessionTraceAtifJsonl({
    agentId: refreshedSession.agent_id,
    session: refreshedSession,
    messages: [
      {
        id: 1,
        session_id: session.id,
        user_id: 'user-1',
        username: 'alice',
        role: 'user',
        content: `Inspect /Users/${localUsername}/work/project/.env and token ghs_abcdefghijklmnopqrstuvwxyz1234567890 via ~${localUsername}/docs from -Users-${localUsername}-src-project and ${highEntropySecret}. Contact user@company.com at 203.0.113.42 or (555) 123-4567. German numbers: +49 170 3330160 and 089/4233232.`,
        created_at: new Date().toISOString(),
      },
      {
        id: 2,
        session_id: session.id,
        user_id: 'assistant',
        username: null,
        role: 'assistant',
        content: `I checked /home/${localUsername}/.config/app and found JWT eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYWRtaW4iLCJzY29wZSI6ImRldiJ9.signaturevalue123. Contact anna.meyer@example.com. SSN 123-45-6789. Card 4111 1111 1111 1111.`,
        created_at: new Date().toISOString(),
      },
    ],
    auditEntries: (
      await import('../src/memory/db.ts')
    ).getStructuredAuditForSession(session.id),
    usageTotals: {
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_tokens: 0,
      total_tool_calls: 1,
      total_cost_usd: 0,
      cost_per_call_usd: 0,
      call_count: 0,
    },
  });

  expect(exported).not.toBeNull();
  const raw = fs.readFileSync(exported?.path || '', 'utf-8').trim();
  const record = JSON.parse(raw) as Record<string, unknown>;

  expect(raw).not.toContain(`/Users/${localUsername}/`);
  expect(raw).not.toContain(`/home/${localUsername}/`);
  expect(raw).not.toContain(`~${localUsername}`);
  expect(raw).not.toContain(`-Users-${localUsername}-`);
  expect(raw).not.toContain(`C:\\Users\\${localUsername}\\`);
  expect(raw).not.toContain(`C:/Users/${localUsername}/`);
  expect(raw).not.toContain(`/mnt/c/Users/${localUsername}/`);
  expect(raw).not.toContain(
    `\\\\wsl.localhost\\Ubuntu\\home\\${localUsername}\\`,
  );
  expect(raw).not.toContain(`//wsl.localhost/Ubuntu/home/${localUsername}/`);
  expect(raw).not.toContain(localUsername);
  expect(raw).toContain('/Users/user_');
  expect(raw).toContain('/home/user_');
  expect(raw).toContain('~user_');
  expect(raw).toContain('-Users-user_');
  expect(raw).not.toContain('ghs_abcdefghijklmnopqrstuvwxyz1234567890');
  expect(raw).not.toContain('gho_abcdefghijklmnopqrstuvwxyz1234567890');
  expect(raw).not.toContain('npm_abcdefghijklmnopqrstuvwxyz123456');
  expect(raw).not.toContain(
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYWRtaW4iLCJzY29wZSI6ImRldiJ9.signaturevalue123',
  );
  expect(raw).not.toContain(highEntropySecret);
  expect(raw).not.toContain('user@company.com');
  expect(raw).not.toContain('anna.meyer@example.com');
  expect(raw).not.toContain('ops@example.com');
  expect(raw).not.toContain('+491701234567');
  expect(raw).not.toContain('+49 170 3330160');
  expect(raw).not.toContain('089/4233232');
  expect(raw).not.toContain('089 4233232');
  expect(raw).not.toContain('203.0.113.42');
  expect(raw).not.toContain('(555) 123-4567');
  expect(raw).not.toContain('123-45-6789');
  expect(raw).not.toContain('4111 1111 1111 1111');
  expect(raw).not.toContain(
    'https://discord.com/api/webhooks/123456/abcdefghijklmnopqrstuvwxyz',
  );
  expect(raw).not.toContain('pypi-abcdefghijklmnopqrstuvwxyz123456');

  const steps = (record.steps as Array<Record<string, unknown>>) || [];
  const userStep = steps[0] || {};
  const agentStep = steps[1] || {};
  const toolCalls =
    (agentStep.tool_calls as Array<Record<string, unknown>>) || [];
  const observations =
    (agentStep.observations as Array<Record<string, unknown>>) || [];
  const toolInput = (toolCalls[0].input as Record<string, unknown>) || {};
  const userContent = String(userStep.content || '');
  const agentContent = String(agentStep.content || '');
  const toolCommandContent = String(toolInput.command || '');
  const observationContent = String(observations[0].content || '');

  expect(userContent).toContain('/Users/user_');
  expect(userContent).toContain('~user_');
  expect(userContent).toContain('-Users-user_');
  expect(userContent).toContain('ghs_ab...7890');
  expect(userContent).toContain('***HIGH_ENTROPY_SECRET_REDACTED***');
  expect(userContent).toContain('***EMAIL_REDACTED***');
  expect(userContent).toContain('***IP_ADDRESS_REDACTED***');
  expect(userContent).toContain('***PHONE_REDACTED***');
  expect(agentContent).toContain('/home/user_');
  expect(agentContent).toContain('***EMAIL_REDACTED***');
  expect(agentContent).toContain('***JWT_REDACTED***');
  expect(agentContent).toContain('***SSN_REDACTED***');
  expect(agentContent).toContain('***CREDIT_CARD_REDACTED***');
  expect(toolCommandContent).toContain('/Users/user_');
  expect(toolCommandContent).toContain('~user_');
  expect(toolCommandContent).toContain('-Users-user_');
  expect(toolCommandContent).toContain('/mnt/c/Users/user_');
  expect(toolCommandContent).toContain('gho_ab...7890');
  expect(toolCommandContent).toContain('npm_ab...3456');
  expect(toolCommandContent).toContain('***HIGH_ENTROPY_SECRET_REDACTED***');
  expect(observationContent).toContain('***DISCORD_WEBHOOK_REDACTED***');
  expect(observationContent).toContain('***PYPI_TOKEN_REDACTED***');
  expect(observationContent).toContain('C:/Users/user_');
  const systemPromptValues = Object.values(
    (record.system_prompts as Record<string, unknown>) || {},
  );
  expect(systemPromptValues).toHaveLength(1);
  expect(String(systemPromptValues[0] || '')).toContain('***EMAIL_REDACTED***');
  expect(String(systemPromptValues[0] || '')).toContain('***PHONE_REDACTED***');
});

test('trace export preserves tool call linkage ids even when they look random', async () => {
  setupHome();

  const { getOrCreateSession, getSessionById, initDatabase, storeMessage } =
    await import('../src/memory/db.ts');
  const { emitToolExecutionAuditEvents, recordAuditEvent } = await import(
    '../src/audit/audit-events.ts'
  );
  const { exportSessionTraceAtifJsonl } = await import(
    '../src/session/session-trace-export.ts'
  );

  initDatabase({ quiet: true });
  const runId = 'turn_Xk9mZr3pWq7vNt2sLf6yBh4jCe8gAa5d';
  const exportedSessionId = 'sess_Xk9mZr3pWq7vNt2sLf6yBh4jCe8gAa5d';
  const session = getOrCreateSession(
    'session-trace-linkage',
    null,
    'channel-trace-linkage',
  );
  storeMessage(session.id, 'user-1', 'alice', 'user', 'Run the command');
  storeMessage(
    session.id,
    'assistant',
    null,
    'assistant',
    'Command completed.',
  );

  recordAuditEvent({
    sessionId: session.id,
    runId,
    event: {
      type: 'turn.start',
      turnIndex: 1,
      userInput: 'Run the command',
      source: 'gateway.chat',
    },
  });
  recordAuditEvent({
    sessionId: session.id,
    runId,
    event: {
      type: 'agent.start',
      provider: 'hybridai',
      model: 'gpt-5-nano',
      systemPrompt: 'You are a focused coding assistant.',
      promptMessages: 2,
      scheduledTaskCount: 0,
    },
  });
  emitToolExecutionAuditEvents({
    sessionId: session.id,
    runId,
    toolExecutions: [
      {
        name: 'bash',
        arguments: '{"command":"echo ok"}',
        result: 'ok',
        durationMs: 15,
        isError: false,
      },
    ],
  });
  recordAuditEvent({
    sessionId: session.id,
    runId,
    event: {
      type: 'turn.end',
      turnIndex: 1,
      finishReason: 'completed',
    },
  });

  const refreshedSession = getSessionById(session.id);
  if (!refreshedSession) {
    throw new Error('Expected refreshed session to exist');
  }

  const exported = await exportSessionTraceAtifJsonl({
    agentId: refreshedSession.agent_id,
    session: {
      ...refreshedSession,
      id: exportedSessionId,
    },
    messages: [
      {
        id: 1,
        session_id: exportedSessionId,
        user_id: 'user-1',
        username: 'alice',
        role: 'user',
        content: 'Run the command',
        created_at: new Date().toISOString(),
      },
      {
        id: 2,
        session_id: exportedSessionId,
        user_id: 'assistant',
        username: null,
        role: 'assistant',
        content: 'Command completed.',
        created_at: new Date().toISOString(),
      },
    ],
    auditEntries: (
      await import('../src/memory/db.ts')
    ).getStructuredAuditForSession(session.id),
    usageTotals: {
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_tokens: 0,
      total_tool_calls: 1,
      total_cost_usd: 0,
      cost_per_call_usd: 0,
      call_count: 0,
    },
  });

  expect(exported).not.toBeNull();
  const raw = fs.readFileSync(exported?.path || '', 'utf-8').trim();
  const record = JSON.parse(raw) as Record<string, unknown>;
  const steps = (record.steps as Array<Record<string, unknown>>) || [];
  const agentStep = steps[1] || {};
  const toolCalls =
    (agentStep.tool_calls as Array<Record<string, unknown>>) || [];
  const observations =
    (agentStep.observations as Array<Record<string, unknown>>) || [];
  const traceId = String(record.trace_id || '');
  const expectedToolCallId = `${runId}:tool:1`;

  expect(traceId).toMatch(
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
  );
  expect(traceId).not.toContain('REDACTED');
  expect(record.session_id).toBe(exportedSessionId);
  expect(raw).toContain(expectedToolCallId);
  expect(toolCalls[0]?.tool_call_id).toBe(expectedToolCallId);
  expect(observations[0]?.source_call_id).toBe(expectedToolCallId);
});
