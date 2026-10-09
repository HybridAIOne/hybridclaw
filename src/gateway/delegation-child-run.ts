import { isRetrySafeRun } from '../../container/shared/retry-safety.js';
import { runAgent } from '../agent/agent.js';
import { buildToolsSummary } from '../agent/tool-summary.js';
import {
  emitToolExecutionAuditEvents,
  makeAuditRunId,
  recordAuditEvent,
} from '../audit/audit-events.js';
import {
  PROACTIVE_AUTO_RETRY_BASE_DELAY_MS,
  PROACTIVE_AUTO_RETRY_ENABLED,
  PROACTIVE_AUTO_RETRY_MAX_ATTEMPTS,
  PROACTIVE_AUTO_RETRY_MAX_DELAY_MS,
  PROACTIVE_DELEGATION_MAX_DEPTH,
} from '../config/config.js';
import { stopSessionHostProcess } from '../infra/host-runner.js';
import { logger } from '../logger.js';
import { resolveModelProvider } from '../providers/factory.js';
import { formatAgentAssignmentHints } from '../skills/agent-scoreboard.js';
import type { ChatMessage } from '../types/api.js';
import type { ContainerOutput } from '../types/container.js';
import type { ArtifactMetadata, ToolExecution } from '../types/execution.js';
import type { TokenUsageStats } from '../types/usage.js';
import { buildMediaGenerationUsageEvents } from '../usage/media-generation-usage.js';
import { resolveUsageCostUsdAfterMetadataRefresh } from '../usage/model-cost.js';
import {
  enqueueTokenUsage,
  readCacheTokenUsage,
} from '../usage/token-usage-buffer.js';
import { sleep } from '../utils/sleep.js';
import {
  type DelegationMode,
  type DelegationRunResult,
  type DelegationRunStatus,
  type DelegationTaskRunInput,
  nextDelegationSessionId,
} from './delegation-plan.js';
import {
  classifyGatewayError,
  type GatewayErrorClass,
} from './gateway-error-utils.js';
import {
  buildTokenUsageAuditPayload,
  maybeRecordGatewayRequestLog,
} from './gateway-service.js';
import { firstNumber } from './gateway-utils.js';

// Subagents get the parent's tools, MCP and plugin tools included, minus these
// (engineering choice, 2026-09-28): schedules, todos, goals and durable memory
// outlive a one-shot child, and the 2FA/resume tools wait on a user the child
// cannot reach. Todos added 2026-09-30, goals 2026-10-01. An email draft or a
// transfer is shown to the user, whom a child does not answer (2026-10-08).
const SUBAGENT_BLOCKED_TOOLS = [
  'cron',
  'todo',
  'draft_email',
  'draft_transfer',
  'track',
  'memory',
  'browser_await_two_factor',
  'browser_resume_interaction',
];

async function persistDelegationAttempt(params: {
  sessionId: string;
  model: string;
  chatbotId: string;
  messages: ChatMessage[];
  durationMs: number;
  output?: Awaited<ReturnType<typeof runAgent>>;
  error?: string;
}): Promise<void> {
  const runId = makeAuditRunId('delegate');
  const toolExecutions = params.output?.toolExecutions || [];
  const toolCallCount = toolExecutions.length;
  emitToolExecutionAuditEvents({
    sessionId: params.sessionId,
    runId,
    toolExecutions,
  });
  if (params.output?.tokenUsage) {
    const usagePayload = buildTokenUsageAuditPayload(
      params.messages,
      params.output.result,
      params.output.tokenUsage,
    );
    recordAuditEvent({
      sessionId: params.sessionId,
      runId,
      event: {
        type: 'model.usage',
        provider: resolveModelProvider(params.model),
        model: params.model,
        durationMs: params.durationMs,
        toolCallCount,
        ...usagePayload,
      },
    });
    enqueueTokenUsage({
      sessionId: params.sessionId,
      agentId: 'delegate',
      model: params.model,
      inputTokens: firstNumber([usagePayload.promptTokens]) || 0,
      outputTokens: firstNumber([usagePayload.completionTokens]) || 0,
      totalTokens: firstNumber([usagePayload.totalTokens]) || 0,
      ...readCacheTokenUsage(params.output.tokenUsage),
      toolCalls: toolCallCount,
      costUsd: await resolveUsageCostUsdAfterMetadataRefresh({
        model: params.model,
        tokenUsage: params.output.tokenUsage,
        usage: usagePayload,
      }),
      auditRunId: runId,
    });
    for (const event of buildMediaGenerationUsageEvents({
      sessionId: params.sessionId,
      agentId: 'delegate',
      auditRunId: runId,
      toolExecutions,
    })) {
      enqueueTokenUsage(event);
    }
  }
  maybeRecordGatewayRequestLog({
    sessionId: params.sessionId,
    model: params.model,
    chatbotId: params.chatbotId,
    messages: params.messages,
    status: params.output?.status === 'success' ? 'success' : 'error',
    response:
      params.output?.status === 'success'
        ? (params.output.result ?? null)
        : null,
    error:
      params.output?.status === 'success'
        ? null
        : params.output?.error || params.error || null,
    toolExecutions,
    toolsUsed: params.output?.toolsUsed || [],
    durationMs: params.durationMs,
  });
}

function resolveSubagentBlockedTools(depth: number): string[] {
  if (depth < PROACTIVE_DELEGATION_MAX_DEPTH) return SUBAGENT_BLOCKED_TOOLS;
  return [...SUBAGENT_BLOCKED_TOOLS, 'delegate'];
}

function buildSubagentSystemPrompt(params: {
  canDelegate: boolean;
  blockedTools: string[];
}): string {
  const { canDelegate, blockedTools } = params;
  const delegationLine = canDelegate
    ? 'You may delegate further only if absolutely necessary and still within depth/turn limits.'
    : 'You are a leaf subagent. Do not delegate further work.';
  const toolsSummary = buildToolsSummary({ blockedTools });

  return [
    '# Subagent Context',
    'You are a delegated subagent spawned by a parent agent for one specific task.',
    '',
    '## Identity',
    '- You are not the end-user assistant; you are a focused worker.',
    '- The next user message is a task handoff from the parent agent.',
    '- Your final response is what the parent uses; make it complete and actionable.',
    '',
    '## Mission',
    '- Complete exactly the delegated task and return concrete results.',
    '- Stay scoped to the assigned objective; no unrelated side quests.',
    '',
    '## Delegation Capability',
    delegationLine,
    '',
    ...(toolsSummary ? [toolsSummary, ''] : []),
    '## Rules',
    '- Do not interact with users directly.',
    '- Do not create schedules or persistent autonomous workflows.',
    '- Do as many tool calls as needed until you have all the information required to fully answer the task.',
    '- When using `web_search`, use multiple searches with varied search terms so you get a more diverse and complete result.',
    '',
    '## Output Format (required)',
    'Use this exact section structure in your final response:',
    '## Completed',
    '- What you accomplished.',
    '## Files Touched',
    '- Exact paths read/modified (or "None").',
    '## Key Findings',
    '- The important technical results for the parent.',
    '## Issues / Limits',
    '- Errors, blockers, or confidence caveats (or "None").',
  ].join('\n');
}

function buildSubagentUserPrompt(params: {
  depth: number;
  mode: DelegationMode;
  canDelegate: boolean;
  taskPrompt: string;
}): string {
  const { depth, mode, canDelegate, taskPrompt } = params;
  const assignmentHints = formatAgentAssignmentHints(taskPrompt);
  return [
    '# Delegated Task',
    `Delegation mode: ${mode}.`,
    `Current delegation depth: ${depth}.`,
    canDelegate
      ? 'Delegation capability: You may delegate further only if absolutely necessary and still within depth/turn limits.'
      : 'Delegation capability: You are a leaf subagent. Do not delegate further work.',
    '',
    ...(assignmentHints ? [assignmentHints, ''] : []),
    'Task handoff from parent:',
    taskPrompt,
  ].join('\n');
}

function inferDelegationStatus(errorText: string): DelegationRunStatus {
  return /timeout|timed out|deadline exceeded/i.test(errorText)
    ? 'timeout'
    : 'failed';
}

function extractDelegationTokenCount(
  tokenUsage?: TokenUsageStats,
): number | undefined {
  if (!tokenUsage) return undefined;
  const total = tokenUsage.apiUsageAvailable
    ? tokenUsage.apiTotalTokens
    : tokenUsage.estimatedTotalTokens;
  if (!Number.isFinite(total) || total <= 0) return undefined;
  return Math.round(total);
}

export async function runDelegationTaskWithRetry(
  input: DelegationTaskRunInput,
): Promise<DelegationRunResult> {
  const {
    parentSessionId,
    childDepth,
    channelId,
    chatbotId,
    enableRag,
    agentId,
    mode,
    task,
    onToolProgress,
    abortSignal,
  } = input;
  const blockedTools = resolveSubagentBlockedTools(childDepth);
  const canDelegate = !blockedTools.includes('delegate');
  const maxAttempts = PROACTIVE_AUTO_RETRY_ENABLED
    ? PROACTIVE_AUTO_RETRY_MAX_ATTEMPTS
    : 1;
  let attempt = 0;
  let delayMs = PROACTIVE_AUTO_RETRY_BASE_DELAY_MS;
  let lastError = 'Delegation failed with unknown error';
  let lastStatus: DelegationRunStatus = 'failed';
  let lastDuration = 0;
  const sessionId = nextDelegationSessionId(parentSessionId, childDepth);
  const requestMessages: ChatMessage[] = [
    {
      role: 'system',
      content: buildSubagentSystemPrompt({
        canDelegate,
        blockedTools,
      }),
    },
    {
      role: 'user',
      content: buildSubagentUserPrompt({
        depth: childDepth,
        mode,
        canDelegate,
        taskPrompt: task.prompt,
      }),
    },
  ];
  let lastToolsUsed: string[] = [];
  let lastToolExecutions: ToolExecution[] = [];
  let lastArtifacts: ArtifactMetadata[] | undefined;
  let lastTokenCount: number | undefined;

  while (attempt < maxAttempts) {
    attempt += 1;
    const startedAt = Date.now();
    let output: ContainerOutput | undefined;
    let toolReported = false;
    try {
      output = await runAgent({
        sessionId,
        messages: requestMessages,
        chatbotId,
        enableRag,
        model: task.model,
        agentId,
        channelId,
        blockedTools,
        abortSignal,
        onToolProgress: (event) => {
          toolReported = true;
          onToolProgress?.(event);
        },
      });
      const durationMs = Date.now() - startedAt;
      lastDuration = durationMs;
      lastToolsUsed = output.toolsUsed || [];
      lastToolExecutions = output.toolExecutions || [];
      lastArtifacts = output.artifacts;
      lastTokenCount = extractDelegationTokenCount(output.tokenUsage);
      await persistDelegationAttempt({
        sessionId,
        model: task.model,
        chatbotId,
        messages: requestMessages,
        durationMs,
        output,
      });

      // A child cannot ask the user; its approval prompt is not a result.
      if (output.pendingApproval) {
        stopSessionHostProcess(sessionId);
        const approval = output.pendingApproval;
        return {
          status: 'blocked',
          sessionId,
          model: task.model,
          durationMs,
          attempts: attempt,
          toolsUsed: output.toolsUsed || [],
          toolExecutions: output.toolExecutions,
          tokenCount: extractDelegationTokenCount(output.tokenUsage),
          error: `needs user approval to run ${approval.toolName || 'a tool'}: ${approval.intent || approval.reason}`,
          artifacts: output.artifacts,
        };
      }

      if (output.status === 'success' && output.result?.trim()) {
        stopSessionHostProcess(sessionId);
        return {
          status: 'completed',
          sessionId,
          model: task.model,
          durationMs,
          attempts: attempt,
          toolsUsed: output.toolsUsed || [],
          tokenCount: extractDelegationTokenCount(output.tokenUsage),
          result: output.result.trim(),
          artifacts: output.artifacts,
        };
      }

      const errorText = output.error || 'Delegated run returned empty output.';
      lastError = errorText;
      lastStatus = inferDelegationStatus(errorText);
      const classification: GatewayErrorClass = classifyGatewayError(errorText);
      const shouldRetry =
        classification === 'transient' && attempt < maxAttempts;
      if (!shouldRetry || !isRetrySafeRun(output, toolReported)) break;

      logger.warn(
        {
          parentSessionId,
          sessionId,
          attempt,
          maxAttempts,
          delayMs,
          errorText,
        },
        'Delegation retry scheduled after transient error',
      );
      await sleep(delayMs);
      delayMs = Math.min(delayMs * 2, PROACTIVE_AUTO_RETRY_MAX_DELAY_MS);
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      lastDuration = durationMs;
      const errorText = err instanceof Error ? err.message : String(err);
      lastError = errorText;
      lastStatus = inferDelegationStatus(errorText);
      await persistDelegationAttempt({
        sessionId,
        model: task.model,
        chatbotId,
        messages: requestMessages,
        durationMs,
        error: errorText,
      });
      const classification: GatewayErrorClass = classifyGatewayError(errorText);
      const shouldRetry =
        classification === 'transient' && attempt < maxAttempts;
      if (!shouldRetry || !isRetrySafeRun(output, toolReported)) break;
      logger.warn(
        {
          parentSessionId,
          sessionId,
          attempt,
          maxAttempts,
          delayMs,
          errorText,
        },
        'Delegation retry scheduled after transient exception',
      );
      await sleep(delayMs);
      delayMs = Math.min(delayMs * 2, PROACTIVE_AUTO_RETRY_MAX_DELAY_MS);
    }
  }

  stopSessionHostProcess(sessionId);
  return {
    status: lastStatus,
    sessionId,
    model: task.model,
    durationMs: lastDuration,
    attempts: attempt,
    toolsUsed: lastToolsUsed,
    toolExecutions: lastToolExecutions,
    tokenCount: lastTokenCount,
    error: lastError,
    artifacts: lastArtifacts,
  };
}
