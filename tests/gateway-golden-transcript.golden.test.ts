import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test, vi } from 'vitest';
import type { ExecutorRequest } from '../src/agent/executor-types.js';
import type { StructuredAuditEntry } from '../src/types/audit.js';
import type { ContainerOutput } from '../src/types/container.js';
import type { ToolExecution } from '../src/types/execution.js';
import type { ToolDefinition } from '../container/src/types.js';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { captureSentryExceptionMock, runAgentMock } = vi.hoisted(() => ({
  captureSentryExceptionMock: vi.fn(),
  runAgentMock: vi.fn(),
}));

vi.mock('../dist/agent/agent.js', () => ({ runAgent: runAgentMock }));
vi.mock('../dist/observability/sentry.js', () => ({
  captureSentryException: captureSentryExceptionMock,
}));

let tempHome = '';
const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-golden-',
  envVars: [
    'AUXILIARY_SESSION_TITLE_PROVIDER',
    'HYBRIDCLAW_AGENT_WORKSPACE_ROOT',
  ],
  cleanup: () => {
    captureSentryExceptionMock.mockReset();
    runAgentMock.mockReset();
    if (tempHome) fs.rmSync(tempHome, { recursive: true, force: true });
    tempHome = '';
  },
});

interface ScenarioHeader {
  type: 'session';
  version: 1;
  name: string;
  request: {
    sessionId: string;
    channelId: string;
    userId: string;
    username: string;
    content: string;
    model: string;
    chatbotId: string;
  };
  traceElapsedMs: number;
}

type ReplayRow =
  | ScenarioHeader
  | { type: 'assistant.thinking'; text: string }
  | { type: 'assistant.text'; text: string }
  | {
      type: 'tool.call';
      name: string;
      arguments: Record<string, unknown>;
      durationMs: number;
    }
  | { type: 'assistant.final'; text: string };

const fixturesDir = fileURLToPath(
  new URL('./fixtures/golden-transcripts/', import.meta.url),
);

function readJsonl(filePath: string): unknown[] {
  return fs
    .readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);
}

function readScenario(name: string): {
  header: ScenarioHeader;
  events: Exclude<ReplayRow, ScenarioHeader>[];
} {
  const rows = readJsonl(path.join(fixturesDir, `${name}.input.jsonl`));
  const header = rows[0] as ScenarioHeader | undefined;
  if (header?.type !== 'session' || header.version !== 1) {
    throw new Error(`${name}: first JSONL row must be a version 1 session`);
  }
  if (header.name !== name) {
    throw new Error(`${name}: session name must match the fixture filename`);
  }
  return {
    header,
    events: rows.slice(1) as Exclude<ReplayRow, ScenarioHeader>[],
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sorted(entry)]),
  );
}

function normalizeString(
  value: string,
  workspacePath: string,
  homePath: string,
): string {
  return value
    .replaceAll(workspacePath, '/workspace')
    .replaceAll(homePath, '<home>')
    .replace(/Node: .*?(?=\n|$)/, 'Node: <node-version>')
    .replace(/OS: .*?(?=\n|$)/, 'OS: <os>')
    .replace(
      /Current Date & Time: .*?(?=\n|$)/,
      'Current Date & Time: <current-time>',
    )
    .replace(/Host: .*?(?=\n|$)/, 'Host: <host>')
    .replace(/Date \(UTC\): \d{4}-\d{2}-\d{2}/, 'Date (UTC): <current-date>')
    .replace(
      /<current_context>\nCurrent date: \d{4}-\d{2}-\d{2}/,
      '<current_context>\nCurrent date: <current-date>',
    )
    .replace(/[^\s"]+:tool:(\d+)/g, '<run>:tool:$1');
}

const RUNTIME_DERIVED_AUDIT_KEYS = new Set([
  'durationMs',
  'historyEstimatedTokens',
  'promptChars',
]);

function normalizeValue(
  value: unknown,
  workspacePath: string,
  homePath: string,
): unknown {
  if (typeof value === 'string') {
    return normalizeString(value, workspacePath, homePath);
  }
  if (Array.isArray(value)) {
    return value.map((entry) =>
      normalizeValue(entry, workspacePath, homePath),
    );
  }
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !RUNTIME_DERIVED_AUDIT_KEYS.has(key))
      .map(([key, entry]) => [
        key,
        normalizeValue(entry, workspacePath, homePath),
      ]),
  );
}

function summarizePrompt(
  prompt: string,
  workspacePath: string,
  homePath: string,
): Record<string, unknown> {
  const normalized = normalizeString(prompt, workspacePath, homePath);
  return {
    bytes: Buffer.byteLength(normalized),
    sha256: sha256(normalized),
    headings: normalized
      .split('\n')
      .filter((line) => /^#{1,3} /.test(line)),
  };
}

function messageText(
  content: ExecutorRequest['messages'][number]['content'],
): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part.type === 'text')
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('\n');
}

function projectAuditRows(
  entries: StructuredAuditEntry[],
  workspacePath: string,
  homePath: string,
): Array<Record<string, unknown>> {
  return [...entries]
    .sort((left, right) => left.seq - right.seq)
    .map((entry) => {
      const payload = JSON.parse(entry.payload) as Record<string, unknown>;
      if (typeof payload.systemPrompt === 'string') {
        payload.systemPrompt = summarizePrompt(
          payload.systemPrompt,
          workspacePath,
          homePath,
        );
      }
      return sorted({
        seq: entry.seq,
        event: entry.event_type,
        payload: normalizeValue(payload, workspacePath, homePath),
      }) as Record<string, unknown>;
    });
}

function toJsonl(rows: unknown[]): string {
  return `${rows.map((row) => JSON.stringify(sorted(row))).join('\n')}\n`;
}

const scenarioNames = fs
  .readdirSync(fixturesDir)
  .filter((name) => name.endsWith('.input.jsonl'))
  .map((name) => name.slice(0, -'.input.jsonl'.length))
  .sort();

async function runGoldenScenario(scenarioName: string): Promise<void> {
  const scenario = readScenario(scenarioName);
  tempHome = setupHome({ AUXILIARY_SESSION_TITLE_PROVIDER: 'disabled' });

  const {
    initDatabase,
    getConversationHistoryPage,
    getRecentStructuredAuditForSession,
    setMessageActivityTrace,
  } = await import('../dist/memory/db.js');
  const { agentWorkspaceDir } = await import('../dist/infra/ipc.js');
  const { ensureBootstrapFiles } = await import('../dist/workspace.js');
  const { ActivityTraceBuilder } = await import(
    '../dist/types/activity-trace.js'
  );
  const { verifyAuditSessionChain } = await import(
    '../dist/audit/audit-trail.js'
  );
  const { redactSecretsDeep } = await import('../dist/security/redact.js');
  const { readDynamicContextMessage } = await import(
    '../dist/gateway/gateway-service.js'
  );

  initDatabase({ quiet: true });
  ensureBootstrapFiles('main');
  const workspacePath = agentWorkspaceDir('main');
  process.env.HYBRIDCLAW_AGENT_WORKSPACE_ROOT = workspacePath;

  const { executeTool, TOOL_DEFINITIONS } = await import(
    '../container/dist/tools.js'
  );
  const traceBuilder = new ActivityTraceBuilder();
  const streamEvents: unknown[] = [];
  let streamedDraft = '';
  let capturedRequest: ExecutorRequest | null = null;

  runAgentMock.mockImplementation(
    async (request: ExecutorRequest): Promise<ContainerOutput> => {
      capturedRequest = request;
      const toolExecutions: ToolExecution[] = [];
      let finalText = '';
      for (const event of scenario.events) {
        if (event.type === 'assistant.thinking') {
          request.onThinkingDelta?.(event.text);
        } else if (event.type === 'assistant.text') {
          request.onTextDelta?.(event.text);
        } else if (event.type === 'tool.call') {
          const argumentsJson = JSON.stringify(event.arguments);
          request.onToolProgress?.({
            sessionId: request.sessionId,
            toolName: event.name,
            phase: 'start',
            preview: argumentsJson,
          });
          const result = await executeTool(event.name, argumentsJson);
          request.onToolProgress?.({
            sessionId: request.sessionId,
            toolName: event.name,
            phase: 'finish',
            preview: result,
            durationMs: event.durationMs,
          });
          toolExecutions.push({
            name: event.name,
            arguments: argumentsJson,
            result,
            durationMs: event.durationMs,
          });
        } else if (event.type === 'assistant.final') {
          finalText = event.text;
        } else {
          throw new Error(`Unsupported replay row: ${JSON.stringify(event)}`);
        }
      }
      return {
        status: 'success',
        result: finalText,
        toolsUsed: toolExecutions.map((execution) => execution.name),
        toolExecutions,
        tokenUsage: {
          modelCalls: 1,
          apiUsageAvailable: true,
          apiPromptTokens: 120,
          apiCompletionTokens: 24,
          apiTotalTokens: 144,
          apiCacheUsageAvailable: false,
          apiCacheReadTokens: 0,
          apiCacheWriteTokens: 0,
          estimatedPromptTokens: 120,
          estimatedCompletionTokens: 24,
          estimatedTotalTokens: 144,
        },
      };
    },
  );

  const onTextDelta = (delta: string): void => {
    streamedDraft += delta;
    streamEvents.push({ type: 'text', delta });
  };
  const onThinkingDelta = (delta: string): void => {
    traceBuilder.pushThinking(delta);
    streamEvents.push({ type: 'thinking', delta });
  };
  const onToolProgress: NonNullable<ExecutorRequest['onToolProgress']> = (
    event,
  ) => {
    if (event.phase === 'start') {
      traceBuilder.pushDraft(streamedDraft);
      streamedDraft = '';
      traceBuilder.startTool(event.toolName, event.preview);
    } else {
      traceBuilder.finishTool(event.toolName, event.durationMs, event.preview);
    }
    streamEvents.push({
      type: 'tool',
      toolName: event.toolName,
      phase: event.phase,
      preview: event.preview,
      durationMs: event.durationMs,
    });
  };

  const { handleGatewayMessage } = await import(
    '../dist/gateway/gateway-chat-service.js'
  );
  const result = await handleGatewayMessage({
    ...scenario.header.request,
    guildId: null,
    workspacePathOverride: workspacePath,
    workspaceDisplayRootOverride: '/workspace',
    source: 'golden.transcript',
    onTextDelta,
    onThinkingDelta,
    onToolProgress,
  });
  streamEvents.push({
    type: 'result',
    status: result.status,
    result: result.result,
  });

  const trace = traceBuilder.build(scenario.header.traceElapsedMs);
  if (!trace || typeof result.assistantMessageId !== 'number') {
    throw new Error(
      'Golden replay did not produce a persistable activity trace',
    );
  }
  setMessageActivityTrace(result.assistantMessageId, trace);

  if (!capturedRequest) throw new Error('Agent request was not captured');
  const request = capturedRequest as ExecutorRequest;
  const systemPrompt = request.messages
    .filter((message) => message.role === 'system')
    .map((message) => messageText(message.content).trim())
    .filter(Boolean)
    .join('\n\n');
  const dynamicContext = readDynamicContextMessage(request.messages);
  const userPrompt = [...request.messages]
    .reverse()
    .find((message) => message.role === 'user');

  const auditEntries = getRecentStructuredAuditForSession(
    scenario.header.request.sessionId,
    100,
  );
  const auditRows = projectAuditRows(auditEntries, workspacePath, tempHome);
  const agentStart = auditEntries.find(
    (entry) => entry.event_type === 'agent.start',
  );
  if (!agentStart) throw new Error('Missing agent.start audit event');
  const agentStartPayload = JSON.parse(agentStart.payload) as Record<
    string,
    unknown
  >;
  expect(agentStartPayload.systemPrompt).toBe(redactSecretsDeep(systemPrompt));
  expect(agentStartPayload.dynamicContext).toBe(
    redactSecretsDeep(dynamicContext),
  );
  expect(agentStartPayload.promptMessages).toBe(request.messages.length);

  const messages = getConversationHistoryPage(
    scenario.header.request.sessionId,
  ).history
    .sort((left, right) => left.id - right.id)
    .map((message) => ({
      id: message.id,
      role: message.role,
      userId: message.user_id,
      username: message.username,
      agentId: message.agent_id ?? null,
      content: message.content,
      activityTrace: message.activityTrace ?? null,
    }));
  expect(messages.at(-1)?.activityTrace).toEqual(trace);
  const auditVerification = verifyAuditSessionChain(
    scenario.header.request.sessionId,
  );
  const wireRows = readJsonl(auditVerification.filePath);
  const transcriptPath = path.join(
    workspacePath,
    '.session-transcripts',
    `${scenario.header.request.sessionId}.jsonl`,
  );
  const transcriptRows = readJsonl(transcriptPath).map((row) => {
    const { createdAt: _createdAt, ...stable } = row as Record<string, unknown>;
    return stable;
  });
  const artifactPath = path.join(workspacePath, 'artifacts/golden-note.txt');
  const coreToolNames = new Set(['read', 'write', 'edit', 'bash']);
  const coreToolSchemas = TOOL_DEFINITIONS.filter((definition: ToolDefinition) =>
    coreToolNames.has(definition.function.name),
  );

  const goldenRows = [
    {
      type: 'request',
      model: request.model,
      chatbotId: request.chatbotId,
      agentId: request.agentId,
      channelId: request.channelId,
      workspacePath: request.workspaceDisplayRootOverride,
      roles: request.messages.map((message) => message.role),
      systemPrompt: summarizePrompt(systemPrompt, workspacePath, tempHome),
      dynamicContext: normalizeString(
        dynamicContext || '',
        workspacePath,
        tempHome,
      ),
      userPrompt: userPrompt ? messageText(userPrompt.content) : null,
    },
    {
      type: 'request-reconstruction-invariant',
      status: 'matched-after-audit-redaction',
      auditSeq: agentStart.seq,
      promptMessages: request.messages.length,
      systemPromptSha256: summarizePrompt(
        systemPrompt,
        workspacePath,
        tempHome,
      ).sha256,
    },
    {
      type: 'tool-catalog',
      names: TOOL_DEFINITIONS.map(
        (definition: ToolDefinition) => definition.function.name,
      ),
      coreSchemas: coreToolSchemas,
    },
    ...auditRows.map((row) => ({ type: 'audit', ...row })),
    {
      type: 'audit-invariant',
      hashChainOk: auditVerification.ok,
      checkedRecords: auditVerification.checkedRecords,
      lastSeq: auditVerification.lastSeq,
      databaseEvents: auditRows.length,
      wireEvents: wireRows.filter(
        (row) => (row as { type?: unknown }).type !== 'metadata',
      ).length,
    },
    { type: 'persistence', messages, transcriptRows },
    { type: 'ui-trace', streamEvents, persisted: trace },
    {
      type: 'filesystem',
      path: 'artifacts/golden-note.txt',
      bytes: fs.statSync(artifactPath).size,
      contents: fs.readFileSync(artifactPath, 'utf8'),
    },
  ];

  expect(auditVerification.errors).toEqual([]);
  expect(auditVerification.ok).toBe(true);
  const actualJsonl = toJsonl(goldenRows);
  const expectedPath = path.join(
    fixturesDir,
    `${scenarioName}.expected.jsonl`,
  );
  if (process.env.HYBRIDCLAW_UPDATE_GOLDEN_TRANSCRIPTS === '1') {
    fs.writeFileSync(expectedPath, actualJsonl, 'utf8');
  }
  expect(actualJsonl).toBe(fs.readFileSync(expectedPath, 'utf8'));
}

test.each(scenarioNames)(
  'replays the %s built-product transcript and snapshots the observable world',
  runGoldenScenario,
);
