/**
 * Delegation — runs `delegate` subagents for a parent session.
 *
 * Children are short-lived `delegate:dN:` sessions with their own container
 * turn; the gateway owns their lifecycle, retries, audit and usage.
 *
 * NOT A2A: peer-agent delegation across instances lives in `src/a2a/`.
 */
import { randomUUID } from 'node:crypto';
import { isRetrySafeRun } from '../../container/shared/retry-safety.js';
import { runAgent } from '../agent/agent.js';
import { enqueueDelegation } from '../agent/delegation-manager.js';
import { buildToolsSummary } from '../agent/tool-summary.js';
import {
  emitToolExecutionAuditEvents,
  makeAuditRunId,
  recordAuditEvent,
} from '../audit/audit-events.js';
import {
  HYBRIDAI_MODEL,
  PROACTIVE_AUTO_RETRY_BASE_DELAY_MS,
  PROACTIVE_AUTO_RETRY_ENABLED,
  PROACTIVE_AUTO_RETRY_MAX_ATTEMPTS,
  PROACTIVE_AUTO_RETRY_MAX_DELAY_MS,
  PROACTIVE_DELEGATION_MAX_DEPTH,
} from '../config/config.js';
import { getRuntimeConfig } from '../config/runtime-config.js';
import { stopSessionHostProcess } from '../infra/host-runner.js';
import { logger } from '../logger.js';
import {
  completeDelegationJob,
  createDelegationJob,
  enqueueProactiveMessage,
  failDelegationJob,
  getDelegationJob,
  markDelegationJobInProgress,
} from '../memory/db.js';
import { memoryService } from '../memory/memory-service.js';
import { resolveModelProvider } from '../providers/factory.js';
import { normalizeHybridAIModelForRuntime } from '../providers/model-names.js';
import { appendSessionTranscript } from '../session/session-transcripts.js';
import { formatAgentAssignmentHints } from '../skills/agent-scoreboard.js';
import type { ChatMessage } from '../types/api.js';
import type { ContainerOutput } from '../types/container.js';
import type {
  ArtifactMetadata,
  ToolExecution,
  ToolProgressEvent,
} from '../types/execution.js';
import type {
  DelegationSideEffect,
  DelegationTaskSpec,
} from '../types/side-effects.js';
import type { TokenUsageStats } from '../types/usage.js';
import { buildMediaGenerationUsageEvents } from '../usage/media-generation-usage.js';
import { resolveUsageCostUsdAfterMetadataRefresh } from '../usage/model-cost.js';
import {
  enqueueTokenUsage,
  readCacheTokenUsage,
} from '../usage/token-usage-buffer.js';
import { sleep } from '../utils/sleep.js';
import { formatDurationMs } from '../utils/text-format.js';
import type { ProactiveMessagePayload } from './fullauto-runtime.js';
import {
  classifyGatewayError,
  type GatewayErrorClass,
} from './gateway-error-utils.js';
import { abbreviateForUser } from './gateway-formatting.js';
import {
  buildTokenUsageAuditPayload,
  maybeRecordGatewayRequestLog,
} from './gateway-service.js';
import { firstNumber } from './gateway-utils.js';

const BASE_SUBAGENT_ALLOWED_TOOLS = [
  'read',
  'write',
  'edit',
  'delete',
  'glob',
  'grep',
  'bash',
  'session_search',
  'web_search',
  'web_fetch',
  'web_extract',
  'http_request',
  'message',
  'browser_navigate',
  'browser_snapshot',
  'browser_click',
  'browser_type',
  'browser_secret_type',
  'browser_upload',
  'browser_press',
  'browser_scroll',
  'browser_back',
  'browser_screenshot',
  'browser_pdf',
  'browser_vision',
  'vision_analyze',
  'audio_transcribe',
  'image_generate',
  'video_generate',
  'browser_get_images',
  'browser_console',
  'browser_network',
  'browser_close',
];
const ORCHESTRATOR_SUBAGENT_ALLOWED_TOOLS = [
  ...BASE_SUBAGENT_ALLOWED_TOOLS,
  'delegate',
];
const MAX_DELEGATION_TASKS = 6;
const MAX_DELEGATION_USER_CHARS = 500;
const MAX_QUEUED_DELEGATION_MESSAGES = 500;
const DELEGATION_STREAM_DELTA_FLUSH_CHARS = 96;

type DelegationMode = 'single' | 'parallel' | 'chain';
type DelegationRunStatus = 'completed' | 'failed' | 'timeout';

interface NormalizedDelegationTask {
  prompt: string;
  label?: string;
  model: string;
}

interface NormalizedDelegationPlan {
  mode: DelegationMode;
  label?: string;
  tasks: NormalizedDelegationTask[];
}

interface DelegationRunResult {
  status: DelegationRunStatus;
  sessionId: string;
  model: string;
  durationMs: number;
  attempts: number;
  toolsUsed: string[];
  toolExecutions?: ToolExecution[];
  tokenCount?: number;
  result?: string;
  error?: string;
  artifacts?: ArtifactMetadata[];
}

interface DelegationCompletionEntry {
  title: string;
  run: DelegationRunResult;
}

interface DelegationStatusEntry {
  title: string;
  model: string;
  status: 'queued' | 'running' | DelegationRunStatus;
  toolUses: number;
  tokenCount?: number;
  currentTool?: string;
  currentToolDetail?: string;
  lastTool?: string;
  lastToolDetail?: string;
}

interface DelegationTaskRunInput {
  parentSessionId: string;
  childDepth: number;
  channelId: string;
  chatbotId: string;
  enableRag: boolean;
  agentId: string;
  mode: DelegationMode;
  task: NormalizedDelegationTask;
  onToolProgress?: (event: ToolProgressEvent) => void;
}

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

export function extractDelegationDepth(sessionId: string): number {
  const match = sessionId.match(/^delegate:d(\d+):/);
  if (!match) return 0;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nextDelegationSessionId(
  parentSessionId: string,
  nextDepth: number,
): string {
  const safeParent = parentSessionId
    .replace(/[^a-zA-Z0-9:_-]/g, '-')
    .slice(0, 48);
  const nonce = randomUUID();
  return `delegate:d${nextDepth}:${safeParent}:${Date.now()}:${nonce}`;
}

function resolveSubagentAllowedTools(depth: number): string[] {
  if (depth < PROACTIVE_DELEGATION_MAX_DEPTH)
    return ORCHESTRATOR_SUBAGENT_ALLOWED_TOOLS;
  return BASE_SUBAGENT_ALLOWED_TOOLS;
}

function buildSubagentSystemPrompt(params: {
  canDelegate: boolean;
  allowedTools: string[];
}): string {
  const { canDelegate, allowedTools } = params;
  const delegationLine = canDelegate
    ? 'You may delegate further only if absolutely necessary and still within depth/turn limits.'
    : 'You are a leaf subagent. Do not delegate further work.';
  const toolsSummary = buildToolsSummary({ allowedTools });

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

function formatDelegationTokenCount(tokenCount?: number): string {
  if (!tokenCount || tokenCount <= 0) return '';
  if (tokenCount < 1_000) return `${tokenCount} tokens`;
  return `${(tokenCount / 1_000).toFixed(1)}k tokens`;
}

function parseToolProgressPreviewObject(
  preview: string,
): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(preview);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

function firstStringToolArg(
  args: Record<string, unknown>,
  keys: string[],
): string {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (Array.isArray(value)) {
      const strings = value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean);
      if (strings.length > 0) return strings.join(', ');
    }
  }
  return '';
}

function extractToolProgressPreviewValue(preview: string, key: string): string {
  const match = preview.match(new RegExp(`"${key}"\\s*:\\s*"([^"]{1,200})`));
  return match?.[1]?.trim() || '';
}

function formatDelegationToolDetail(event: ToolProgressEvent): string {
  const preview = String(event.preview || '').trim();
  if (!preview) return '';

  const args = parseToolProgressPreviewObject(preview);
  if (args) {
    const toolName = event.toolName.toLowerCase();
    const url = firstStringToolArg(args, ['url', 'href', 'uri']);
    if (
      url &&
      (toolName.includes('web') ||
        toolName.includes('browser') ||
        toolName.includes('http'))
    ) {
      return abbreviateForUser(url, 96);
    }
    const query = firstStringToolArg(args, ['query', 'q', 'search_query']);
    if (query) return abbreviateForUser(query, 96);
    const pathValue = firstStringToolArg(args, [
      'path',
      'file',
      'file_path',
      'cwd',
      'workdir',
    ]);
    if (pathValue) return abbreviateForUser(pathValue, 96);
    const command = firstStringToolArg(args, ['cmd', 'command']);
    if (command) return abbreviateForUser(command, 96);
    const selector = firstStringToolArg(args, ['selector', 'ref_id', 'id']);
    if (selector) return abbreviateForUser(selector, 96);
  }

  for (const key of ['url', 'href', 'uri', 'query', 'q', 'path', 'cmd']) {
    const value = extractToolProgressPreviewValue(preview, key);
    if (value) return abbreviateForUser(value, 96);
  }

  return abbreviateForUser(preview, 96);
}

function normalizeDelegationTask(
  raw: unknown,
  params: {
    fallbackModel: string;
    parentModel: string;
    configuredDelegateModel: string;
  },
): NormalizedDelegationTask | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const task = raw as DelegationTaskSpec;
  const prompt = typeof task.prompt === 'string' ? task.prompt.trim() : '';
  if (!prompt) return null;
  const label = typeof task.label === 'string' ? task.label.trim() : '';
  const model = resolveDelegationRequestedModel({
    requestedModel: task.model,
    fallbackModel: params.fallbackModel,
    parentModel: params.parentModel,
    configuredDelegateModel: params.configuredDelegateModel,
  });
  return {
    prompt,
    label: label || undefined,
    model,
  };
}

function resolveDelegationFallbackModel(parentModel: string): string {
  return getRuntimeConfig().proactive.delegation.model.trim() || parentModel;
}

function areEquivalentDelegationModels(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  const leftTrimmed = String(left || '').trim();
  const rightTrimmed = String(right || '').trim();
  if (!leftTrimmed || !rightTrimmed) return false;
  if (
    leftTrimmed.localeCompare(rightTrimmed, undefined, {
      sensitivity: 'accent',
    }) === 0
  ) {
    return true;
  }
  return (
    normalizeHybridAIModelForRuntime(leftTrimmed).toLowerCase() ===
    normalizeHybridAIModelForRuntime(rightTrimmed).toLowerCase()
  );
}

function resolveDelegationRequestedModel(params: {
  requestedModel: string | null | undefined;
  fallbackModel: string;
  parentModel: string;
  configuredDelegateModel: string;
}): string {
  const requestedModel = String(params.requestedModel || '').trim();
  if (!requestedModel) return params.fallbackModel;
  if (
    params.configuredDelegateModel &&
    params.parentModel &&
    areEquivalentDelegationModels(requestedModel, params.parentModel) &&
    !areEquivalentDelegationModels(
      requestedModel,
      params.configuredDelegateModel,
    )
  ) {
    return params.configuredDelegateModel;
  }
  return requestedModel;
}

export function normalizeDelegationEffect(
  effect: DelegationSideEffect,
  fallbackModel: string,
): {
  plan?: NormalizedDelegationPlan;
  error?: string;
} {
  const rawMode =
    typeof effect.mode === 'string' ? effect.mode.trim().toLowerCase() : '';
  const modeRaw: DelegationMode | '' =
    rawMode === 'single' || rawMode === 'parallel' || rawMode === 'chain'
      ? rawMode
      : '';
  if (rawMode && !modeRaw) {
    return { error: 'Invalid delegation mode' };
  }

  const label = typeof effect.label === 'string' ? effect.label.trim() : '';
  const configuredDelegateModel =
    getRuntimeConfig().proactive.delegation.model.trim();
  const resolvedFallbackModel =
    configuredDelegateModel || resolveDelegationFallbackModel(fallbackModel);
  const baseModel = resolveDelegationRequestedModel({
    requestedModel: effect.model,
    fallbackModel: resolvedFallbackModel,
    parentModel: fallbackModel,
    configuredDelegateModel,
  });
  const prompt = typeof effect.prompt === 'string' ? effect.prompt.trim() : '';
  const rawTasks = Array.isArray(effect.tasks) ? effect.tasks : [];
  const rawChain = Array.isArray(effect.chain) ? effect.chain : [];

  let mode: DelegationMode;
  if (modeRaw) mode = modeRaw;
  else if (rawChain.length > 0) mode = 'chain';
  else if (rawTasks.length > 0) mode = 'parallel';
  else mode = 'single';

  if (mode === 'single') {
    if (!prompt) return { error: 'Single-mode delegation missing prompt' };
    return {
      plan: {
        mode,
        label: label || undefined,
        tasks: [{ prompt, label: label || undefined, model: baseModel }],
      },
    };
  }

  const sourceTasks = mode === 'parallel' ? rawTasks : rawChain;
  if (sourceTasks.length === 0) {
    return { error: `${mode} delegation requires at least one task` };
  }
  if (sourceTasks.length > MAX_DELEGATION_TASKS) {
    return {
      error: `${mode} delegation exceeds max tasks (${MAX_DELEGATION_TASKS})`,
    };
  }
  const tasks: NormalizedDelegationTask[] = [];
  for (let i = 0; i < sourceTasks.length; i++) {
    const normalized = normalizeDelegationTask(sourceTasks[i], {
      fallbackModel: baseModel,
      parentModel: fallbackModel,
      configuredDelegateModel,
    });
    if (!normalized)
      return { error: `${mode} delegation task #${i + 1} is invalid` };
    tasks.push(normalized);
  }
  return {
    plan: {
      mode,
      label: label || undefined,
      tasks,
    },
  };
}

function renderDelegationTaskTitle(
  mode: DelegationMode,
  task: NormalizedDelegationTask,
  index: number,
  total: number,
): string {
  if (task.label && !/[-_]/.test(task.label)) return task.label;
  const promptTitle = task.prompt
    .split(/\r?\n/, 1)[0]
    ?.replace(/\s+/g, ' ')
    .replace(/[.:;,\s]+$/, '')
    .trim();
  if (promptTitle) return abbreviateForUser(promptTitle, 72);
  if (mode === 'chain') return `step ${index + 1}/${total}`;
  if (mode === 'parallel') return `task ${index + 1}/${total}`;
  return 'task';
}

function interpolateChainPrompt(
  prompt: string,
  previousResult: string,
): string {
  if (!prompt.includes('{previous}')) return prompt;
  const replacement = previousResult.trim() || '(no previous output)';
  return prompt.replace(/\{previous\}/g, replacement);
}

async function runDelegationTaskWithRetry(
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
  } = input;
  const allowedTools = resolveSubagentAllowedTools(childDepth);
  const canDelegate = allowedTools.includes('delegate');
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
        allowedTools,
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
        allowedTools,
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

function formatDelegationCompletion(params: {
  mode: DelegationMode;
  label?: string;
  entries: DelegationCompletionEntry[];
  totalDurationMs: number;
}): { forUser: string; forLLM: string; artifacts?: ArtifactMetadata[] } {
  const { mode, label, entries, totalDurationMs } = params;
  const completedCount = entries.filter(
    (entry) => entry.run.status === 'completed',
  ).length;
  const failedCount = entries.length - completedCount;
  const overallStatus =
    failedCount === 0
      ? 'completed'
      : completedCount === 0
        ? 'failed'
        : 'partial';
  const heading = label?.trim()
    ? `[Delegate: ${label.trim()}]`
    : `[Delegate ${mode}]`;

  const userLines = [
    `${heading} ${overallStatus} (${completedCount}/${entries.length} completed, ${formatDurationMs(totalDurationMs)}).`,
  ];
  for (const entry of entries) {
    if (entry.run.status === 'completed') {
      userLines.push(
        `- ${entry.title}: ${abbreviateForUser(entry.run.result || '', MAX_DELEGATION_USER_CHARS)}`,
      );
    } else {
      userLines.push(
        `- ${entry.title}: ${entry.run.status} (${abbreviateForUser(entry.run.error || 'Unknown error', MAX_DELEGATION_USER_CHARS)})`,
      );
    }
  }

  const llmLines = [
    `${heading} ${overallStatus}`,
    `mode: ${mode}`,
    `completed: ${completedCount}/${entries.length}`,
    `duration_ms_total: ${totalDurationMs}`,
    '',
  ];
  for (const entry of entries) {
    llmLines.push(`## ${entry.title}`);
    llmLines.push(`status: ${entry.run.status}`);
    llmLines.push(`session_id: ${entry.run.sessionId}`);
    llmLines.push(`model: ${entry.run.model}`);
    llmLines.push(`duration_ms: ${entry.run.durationMs}`);
    llmLines.push(`attempts: ${entry.run.attempts}`);
    if (entry.run.toolsUsed.length > 0) {
      llmLines.push(`tools_used: ${entry.run.toolsUsed.join(', ')}`);
    }
    if (entry.run.status === 'completed') {
      llmLines.push('');
      llmLines.push(entry.run.result || '(empty result)');
    } else {
      llmLines.push(`error: ${entry.run.error || 'Unknown error'}`);
    }
    llmLines.push('');
  }

  const artifacts: ArtifactMetadata[] = [];
  const seenArtifactKeys = new Set<string>();
  for (const entry of entries) {
    for (const artifact of entry.run.artifacts || []) {
      if (!artifact?.path) continue;
      const key = `${artifact.path}|${artifact.filename}|${artifact.mimeType}`;
      if (seenArtifactKeys.has(key)) continue;
      seenArtifactKeys.add(key);
      artifacts.push(artifact);
    }
  }

  return {
    forUser: abbreviateForUser(userLines.join('\n'), MAX_DELEGATION_USER_CHARS),
    forLLM: llmLines.join('\n').trimEnd(),
    ...(artifacts.length > 0 ? { artifacts } : {}),
  };
}

function formatDelegationStatus(params: {
  label?: string;
  entries: DelegationStatusEntry[];
  parentModel?: string;
}): string {
  const runningCount = params.entries.filter(
    (entry) => entry.status === 'running' || entry.status === 'queued',
  ).length;
  const finishedCount = params.entries.length - runningCount;
  const distinctDelegateModels = Array.from(
    new Set(
      params.entries
        .map((entry) => entry.model.trim())
        .filter(
          (model) =>
            model &&
            (!params.parentModel ||
              model.localeCompare(params.parentModel, undefined, {
                sensitivity: 'accent',
              }) !== 0),
        ),
    ),
  );
  const modelSuffix =
    distinctDelegateModels.length > 0
      ? ` (${distinctDelegateModels.join(', ')})`
      : '';
  const heading =
    runningCount > 0
      ? `Running ${runningCount} delegate jobs${modelSuffix}`
      : `${finishedCount} delegate jobs finished${modelSuffix}`;
  const lines = ['[Delegate Status]', heading];
  params.entries.forEach((entry, index) => {
    const prefix = index === params.entries.length - 1 ? '└' : '├';
    const donePrefix = index === params.entries.length - 1 ? '   └' : '│  └';
    const toolLabel =
      entry.toolUses === 1 ? '1 tool use' : `${entry.toolUses} tool uses`;
    const tokenLabel = formatDelegationTokenCount(entry.tokenCount);
    const statusLabel =
      entry.status === 'queued'
        ? 'initializing'
        : entry.status === 'running'
          ? entry.currentTool
            ? `running ${entry.currentTool}${entry.currentToolDetail ? ` ${entry.currentToolDetail}` : ''}`
            : entry.lastTool
              ? `thinking after ${entry.lastTool}${entry.lastToolDetail ? ` ${entry.lastToolDetail}` : ''}`
              : 'starting'
          : entry.status;
    lines.push(
      `${prefix} ${entry.title} · ${toolLabel}${tokenLabel ? ` · ${tokenLabel}` : ''}`,
    );
    lines.push(
      `${donePrefix} ${statusLabel === 'completed' ? 'Done' : statusLabel}`,
    );
  });
  return lines.join('\n');
}

async function synthesizeDelegationFinal(params: {
  parentSessionId: string;
  channelId: string;
  chatbotId: string;
  enableRag: boolean;
  agentId: string;
  model: string;
  parentPrompt?: string;
  parentResult?: string;
  delegationResults: string;
  onTextDelta?: (delta: string) => void;
}): Promise<string | null> {
  if (!params.parentPrompt?.trim()) return null;
  const sessionId = nextDelegationSessionId(params.parentSessionId, 0);
  const output = await runAgent({
    sessionId,
    messages: [
      {
        role: 'system',
        content: [
          'You are synthesizing the final user-facing answer after delegated research completed.',
          'Use the delegated results as source material.',
          'Return only the final answer to the user.',
          'Do not say you are waiting for delegates.',
          'Do not mention internal session ids.',
        ].join('\n'),
      },
      {
        role: 'user',
        content: [
          'Original user request:',
          params.parentPrompt.trim(),
          '',
          'Parent provisional response:',
          params.parentResult?.trim() || '(none)',
          '',
          'Delegated results:',
          params.delegationResults.trim(),
        ].join('\n'),
      },
    ],
    chatbotId: params.chatbotId,
    enableRag: params.enableRag,
    model: params.model,
    agentId: params.agentId,
    channelId: params.channelId,
    allowedTools: [],
    onTextDelta: params.onTextDelta,
  });
  stopSessionHostProcess(sessionId);
  if (output.status !== 'success') return null;
  const result = output.result?.trim();
  return result || null;
}

function queueDelegationProactiveMessage(params: {
  parentSessionId: string;
  channelId: string;
  text: string;
  artifactCount: number;
  source?: string;
}): void {
  const { queued, dropped } = enqueueProactiveMessage(
    params.channelId,
    params.text,
    params.source || 'delegate',
    MAX_QUEUED_DELEGATION_MESSAGES,
  );
  logger.info(
    {
      parentSessionId: params.parentSessionId,
      channelId: params.channelId,
      queued,
      dropped,
      artifactCount: params.artifactCount,
    },
    'Delegation proactive message queued',
  );
  if (params.artifactCount > 0) {
    logger.warn(
      {
        parentSessionId: params.parentSessionId,
        channelId: params.channelId,
        artifactCount: params.artifactCount,
      },
      'Queued delegation message does not persist attachments; only text was queued',
    );
  }
}

function createDelegationSynthesisStream(params: {
  parentSessionId: string;
  channelId: string;
}): {
  onTextDelta: (delta: string) => void;
  finish: () => void;
  started: () => boolean;
  text: () => string;
} {
  let hasStarted = false;
  let hasFinished = false;
  let buffer = '';
  let streamedText = '';

  const queue = (source: string, text: string): void => {
    queueDelegationProactiveMessage({
      parentSessionId: params.parentSessionId,
      channelId: params.channelId,
      text,
      artifactCount: 0,
      source,
    });
  };

  const ensureStarted = (): void => {
    if (hasStarted) return;
    hasStarted = true;
    queue('delegate:stream:start', '');
  };

  const flush = (): void => {
    if (!buffer) return;
    ensureStarted();
    queue('delegate:stream:delta', buffer);
    buffer = '';
  };

  return {
    onTextDelta: (delta: string) => {
      const text = String(delta || '');
      if (!text) return;
      streamedText += text;
      buffer += text;
      if (
        buffer.length >= DELEGATION_STREAM_DELTA_FLUSH_CHARS ||
        buffer.endsWith('\n')
      ) {
        flush();
      }
    },
    finish: () => {
      if (hasFinished) return;
      hasFinished = true;
      if (!hasStarted && !buffer) return;
      flush();
      queue('delegate:stream:end', '');
    },
    started: () => hasStarted,
    text: () => streamedText,
  };
}

async function publishDelegationLifecycleMessage(params: {
  parentSessionId: string;
  channelId: string;
  text: string;
  artifacts?: ArtifactMetadata[];
  onProactiveMessage?: (
    message: ProactiveMessagePayload,
  ) => void | Promise<void>;
}): Promise<void> {
  const text = params.text.trim();
  if (!text) return;
  const artifactCount = params.artifacts?.length || 0;

  if (params.onProactiveMessage) {
    try {
      await params.onProactiveMessage({
        text,
        artifacts: params.artifacts,
      });
      return;
    } catch (err) {
      logger.warn(
        {
          parentSessionId: params.parentSessionId,
          channelId: params.channelId,
          err,
        },
        'Delegation proactive callback failed; falling back to queue',
      );
    }
  }

  queueDelegationProactiveMessage({
    parentSessionId: params.parentSessionId,
    channelId: params.channelId,
    text,
    artifactCount,
  });
}

async function publishDelegationCompletion(params: {
  parentSessionId: string;
  channelId: string;
  agentId: string;
  forLLM: string;
  forUser: string;
  artifacts?: ArtifactMetadata[];
  publishForUser?: boolean;
  onProactiveMessage?: (
    message: ProactiveMessagePayload,
  ) => void | Promise<void>;
}): Promise<void> {
  const {
    parentSessionId,
    channelId,
    agentId,
    forLLM,
    forUser,
    artifacts,
    publishForUser = true,
    onProactiveMessage,
  } = params;

  memoryService.storeMessage({
    sessionId: parentSessionId,
    userId: 'assistant',
    username: null,
    role: 'assistant',
    content: forLLM,
    agentId,
  });
  appendSessionTranscript(agentId, {
    sessionId: parentSessionId,
    channelId,
    role: 'assistant',
    userId: 'assistant',
    username: null,
    content: forLLM,
  });

  const trimmedForUser = forUser.trim();
  if (trimmedForUser && trimmedForUser !== forLLM.trim()) {
    memoryService.storeMessage({
      sessionId: parentSessionId,
      userId: 'assistant',
      username: null,
      role: 'assistant',
      content: trimmedForUser,
      agentId,
      artifacts: artifacts?.length ? artifacts : null,
    });
    appendSessionTranscript(agentId, {
      sessionId: parentSessionId,
      channelId,
      role: 'assistant',
      userId: 'assistant',
      username: null,
      content: trimmedForUser,
    });
  }

  if (publishForUser) {
    await publishDelegationLifecycleMessage({
      parentSessionId,
      channelId,
      text: forUser,
      artifacts,
      onProactiveMessage,
    });
  }
}

export function enqueueDelegationBatchFromSideEffects(params: {
  plans: NormalizedDelegationPlan[];
  parentSessionId: string;
  channelId: string;
  chatbotId: string;
  enableRag: boolean;
  agentId: string;
  parentModel?: string;
  onProactiveMessage?: (
    message: ProactiveMessagePayload,
  ) => void | Promise<void>;
  parentDepth: number;
  parentPrompt?: string;
  parentResult?: string;
  publicId?: string;
  ackText?: string;
}): { publicId: string } | null {
  const {
    plans,
    parentSessionId,
    channelId,
    chatbotId,
    enableRag,
    agentId,
    parentModel,
    onProactiveMessage,
    parentDepth,
    parentPrompt,
    parentResult,
    publicId: requestedPublicId,
    ackText,
  } = params;
  const activePlans = plans.filter((plan) => plan.tasks.length > 0);
  if (activePlans.length === 0) return null;
  const childDepth = parentDepth + 1;
  if (childDepth > PROACTIVE_DELEGATION_MAX_DEPTH) {
    logger.info(
      { parentSessionId, childDepth, maxDepth: PROACTIVE_DELEGATION_MAX_DEPTH },
      'Delegation skipped — depth limit reached',
    );
    return null;
  }

  const statusEntries: DelegationStatusEntry[] = [];
  const statusEntriesByPlan = activePlans.map((plan) =>
    plan.tasks.map((task, index) => {
      const entry: DelegationStatusEntry = {
        title: renderDelegationTaskTitle(
          plan.mode,
          task,
          index,
          plan.tasks.length,
        ),
        model: task.model,
        status: 'queued',
        toolUses: 0,
      };
      statusEntries.push(entry);
      return entry;
    }),
  );
  const batchLabel =
    activePlans.length === 1
      ? activePlans[0]?.label
      : activePlans
          .map((plan) => plan.label)
          .filter(Boolean)
          .join(', ') || undefined;

  const jobId = `${parentSessionId}:${Date.now()}:${randomUUID()}`;
  const publicId =
    requestedPublicId?.trim() ||
    `dlg_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  try {
    createDelegationJob({
      publicId,
      internalId: jobId,
      parentSessionId,
      channelId,
      agentId,
      model: parentModel || null,
      taskCount: statusEntries.length,
      ackText: ackText || null,
    });
  } catch (err) {
    logger.error(
      {
        err,
        parentSessionId,
        channelId,
        publicId,
        internalId: jobId,
      },
      'Failed to create delegation job row',
    );
    return null;
  }

  const accepted = enqueueDelegation({
    id: jobId,
    run: async () => {
      if (getDelegationJob(publicId)?.status === 'cancelled') return;
      markDelegationJobInProgress(publicId);
      const startedAt = Date.now();
      const entries: DelegationCompletionEntry[] = [];
      try {
        await publishDelegationLifecycleMessage({
          parentSessionId,
          channelId,
          text: formatDelegationStatus({
            label: batchLabel,
            entries: statusEntries,
            parentModel,
          }),
          onProactiveMessage,
        });

        let statusPublishChain = Promise.resolve();
        const publishStatus = (): Promise<void> => {
          const text = formatDelegationStatus({
            label: batchLabel,
            entries: statusEntries,
            parentModel,
          });
          statusPublishChain = statusPublishChain
            .catch(() => undefined)
            .then(() =>
              publishDelegationLifecycleMessage({
                parentSessionId,
                channelId,
                text,
                onProactiveMessage,
              }),
            );
          return statusPublishChain;
        };
        const runTask = async (params: {
          plan: NormalizedDelegationPlan;
          task: NormalizedDelegationTask;
          index: number;
          statusEntry: DelegationStatusEntry;
          prompt?: string;
        }): Promise<DelegationCompletionEntry> => {
          const { plan, task, statusEntry, prompt } = params;
          statusEntry.status = 'running';
          await publishStatus();
          const run = await runDelegationTaskWithRetry({
            parentSessionId,
            childDepth,
            channelId,
            chatbotId,
            enableRag,
            agentId,
            mode: plan.mode,
            task: prompt ? { ...task, prompt } : task,
            onToolProgress: (event) => {
              if (event.phase === 'finish') {
                statusEntry.toolUses += 1;
                statusEntry.lastTool =
                  statusEntry.currentTool ?? event.toolName;
                statusEntry.lastToolDetail = statusEntry.currentToolDetail;
                statusEntry.currentTool = undefined;
                statusEntry.currentToolDetail = undefined;
                void publishStatus();
                return;
              }
              statusEntry.currentTool = event.toolName;
              statusEntry.currentToolDetail = formatDelegationToolDetail(event);
              void publishStatus();
            },
          });
          statusEntry.status = run.status;
          statusEntry.currentTool = undefined;
          statusEntry.currentToolDetail = undefined;
          statusEntry.lastTool = undefined;
          statusEntry.lastToolDetail = undefined;
          statusEntry.toolUses = Math.max(
            statusEntry.toolUses,
            run.toolsUsed.length,
          );
          statusEntry.tokenCount = run.tokenCount;
          await publishStatus();
          return {
            title: statusEntry.title,
            run,
          };
        };

        const runPlan = async (
          plan: NormalizedDelegationPlan,
          planIndex: number,
        ): Promise<DelegationCompletionEntry[]> => {
          const planStatusEntries = statusEntriesByPlan[planIndex] || [];
          if (plan.mode === 'parallel') {
            return Promise.all(
              plan.tasks.map(async (task, index) =>
                runTask({
                  plan,
                  task,
                  index,
                  statusEntry: planStatusEntries[index],
                }),
              ),
            );
          }

          if (plan.mode === 'chain') {
            const planEntries: DelegationCompletionEntry[] = [];
            let previousResult = '';
            for (let i = 0; i < plan.tasks.length; i++) {
              const task = plan.tasks[i];
              const entry = await runTask({
                plan,
                task,
                index: i,
                statusEntry: planStatusEntries[i],
                prompt: interpolateChainPrompt(task.prompt, previousResult),
              });
              planEntries.push(entry);
              if (entry.run.status !== 'completed') break;
              previousResult = entry.run.result || '';
            }
            return planEntries;
          }

          const task = plan.tasks[0];
          return [
            await runTask({
              plan,
              task,
              index: 0,
              statusEntry: planStatusEntries[0],
            }),
          ];
        };

        const planEntries = await Promise.all(
          activePlans.map(async (plan, planIndex) => runPlan(plan, planIndex)),
        );
        entries.push(...planEntries.flat());

        if (entries.length === 0) {
          logger.warn(
            { parentSessionId, planCount: activePlans.length },
            'Delegation produced no entries',
          );
          failDelegationJob(publicId, 'no_delegation_entries');
          return;
        }

        const completion = formatDelegationCompletion({
          mode:
            activePlans.length === 1
              ? activePlans[0]?.mode || 'single'
              : 'parallel',
          label: batchLabel,
          entries,
          totalDurationMs: Date.now() - startedAt,
        });
        let finalForUser: string | null = null;
        let streamedFinal = false;
        let synthesisStream: ReturnType<
          typeof createDelegationSynthesisStream
        > | null = null;
        try {
          synthesisStream =
            channelId === 'tui'
              ? createDelegationSynthesisStream({
                  parentSessionId,
                  channelId,
                })
              : null;
          finalForUser = await synthesizeDelegationFinal({
            parentSessionId,
            channelId,
            chatbotId,
            enableRag,
            agentId,
            model: parentModel || HYBRIDAI_MODEL,
            parentPrompt,
            parentResult,
            delegationResults: completion.forLLM,
            onTextDelta: synthesisStream?.onTextDelta,
          });
          synthesisStream?.finish();
          streamedFinal =
            Boolean(finalForUser) &&
            (synthesisStream?.started() === true ||
              Boolean(synthesisStream?.text().trim()));
          if (streamedFinal && synthesisStream) {
            finalForUser = synthesisStream.text().trim() || finalForUser;
          }
        } catch (err) {
          logger.warn(
            { parentSessionId, channelId, err },
            'Delegation final synthesis failed; using completion summary',
          );
        } finally {
          synthesisStream?.finish();
        }
        const resultText = finalForUser || completion.forUser;
        await publishDelegationCompletion({
          parentSessionId,
          channelId,
          agentId,
          forLLM: completion.forLLM,
          forUser: resultText,
          artifacts: completion.artifacts,
          publishForUser: !streamedFinal,
          onProactiveMessage,
        });
        completeDelegationJob(publicId, {
          resultText,
          resultDigest: completion.forLLM,
          artifacts: completion.artifacts,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failDelegationJob(publicId, message);
        logger.error(
          { err, parentSessionId, channelId, publicId, internalId: jobId },
          'Delegation batch failed',
        );
      } finally {
        const row = getDelegationJob(publicId);
        if (row?.status === 'queued' || row?.status === 'in_progress') {
          failDelegationJob(publicId, 'unknown_termination');
        }
      }
    },
  });
  if (!accepted) {
    failDelegationJob(publicId, 'delegation_disabled');
    return null;
  }
  return { publicId };
}
