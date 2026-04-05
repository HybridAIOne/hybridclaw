import path from 'node:path';

import {
  type ToolApprovalEvaluation,
  TrustedCoworkerApprovalRuntime,
} from './approval-policy.js';
import { discoverArtifactsSince, inferArtifactMimeType } from './artifacts.js';
import { cleanupAllBrowserSessions } from './browser-tools.js';
import { applyContextGuard } from './context-guard.js';
import {
  emitRuntimeEvent,
  runAfterToolHooks,
  runBeforeToolHooks,
} from './extensions.js';
import { compactInLoop } from './in-loop-compaction.js';
import { waitForInput, writeOutput } from './ipc.js';
import { McpClientManager } from './mcp/client-manager.js';
import { McpConfigWatcher } from './mcp/config-watcher.js';
import {
  formatModelErrorForLog,
  isRetryableModelError,
  shouldDowngradeStreamToNonStreaming,
} from './model-retry.js';
import {
  injectNativeAudioContent,
  injectNativeVisionContent,
  shouldRetryWithoutNativeMedia,
} from './native-media.js';
import { callAuxiliaryModel } from './providers/auxiliary.js';
import { callRoutedModel, callRoutedModelStream } from './providers/router.js';
import {
  isHybridAIEmptyVisibleCompletion,
  ProviderRequestError,
  summarizeHybridAICompletionForDebug,
} from './providers/shared.js';
import {
  buildRalphPrompt,
  normalizeMessageContentToText,
  parseRalphChoice,
  stripRalphChoiceTags,
} from './ralph.js';
import { injectRuntimeCapabilitiesMessage } from './runtime-capabilities.js';
import {
  resolveWorkspacePath,
  WORKSPACE_ROOT,
  WORKSPACE_ROOT_DISPLAY,
} from './runtime-paths.js';
import {
  advanceStalledTurnCount,
  MAX_STALLED_MODEL_TURNS,
} from './stalled-turns.js';
import {
  collapseSystemMessages,
  mergeSystemMessage,
} from './system-messages.js';
import {
  accumulateApiUsage,
  createTokenEstimateCache,
  createTokenUsageStats,
  estimateMessageTokens,
  estimateTextTokens,
  finalizeTokenUsage,
} from './token-usage.js';
import { validateStructuredToolCalls } from './tool-call-validation.js';
import type { ToolCallHistoryEntry } from './tool-loop-detection.js';
import {
  detectToolCallLoop,
  isLoopGuardedToolName,
  recordToolCallOutcome,
} from './tool-loop-detection.js';
import {
  getToolExecutionMode,
  mapConcurrentInOrder,
  takeCachedValue,
} from './tool-parallelism.js';
import {
  executeToolWithMetadata,
  getMessageToolDescription,
  getPendingSideEffects,
  getPluginToolDefinitions,
  resetPersistentBashSessions,
  resetSideEffects,
  setGatewayContext,
  setMcpClientManager,
  setMediaContext,
  setModelContext,
  setPersistentBashStateEnabled,
  setPluginTools,
  setScheduledTasks,
  setSessionContext,
  setTaskModelPolicies,
  setWebSearchConfig,
  TOOL_DEFINITIONS,
} from './tools.js';
import {
  type ArtifactMetadata,
  type ChatCompletionResponse,
  type ChatMessage,
  type ContainerInput,
  type ContainerOutput,
  type PendingApproval,
  TASK_MODEL_KEYS,
  type ToolCall,
  type ToolDefinition,
  type ToolExecution,
} from './types.js';

const IDLE_TIMEOUT_MS = parseInt(
  process.env.CONTAINER_IDLE_TIMEOUT || '300000',
  10,
); // 5 min
const RETRY_ENABLED = process.env.HYBRIDCLAW_RETRY_ENABLED !== 'false';
const RETRY_MAX_ATTEMPTS = Math.max(
  1,
  parseInt(process.env.HYBRIDCLAW_RETRY_MAX_ATTEMPTS || '3', 10),
);
const RETRY_BASE_DELAY_MS = Math.max(
  100,
  parseInt(process.env.HYBRIDCLAW_RETRY_BASE_DELAY_MS || '2000', 10),
);
const RETRY_MAX_DELAY_MS = Math.max(
  RETRY_BASE_DELAY_MS,
  parseInt(process.env.HYBRIDCLAW_RETRY_MAX_DELAY_MS || '8000', 10),
);
const MAX_PARALLEL_TOOL_CALLS = 8;
const RAW_DEFAULT_RALPH_MAX_EXTRA_ITERATIONS = Number.parseInt(
  process.env.HYBRIDCLAW_RALPH_MAX_ITERATIONS || '0',
  10,
);
const DEFAULT_RALPH_MAX_EXTRA_ITERATIONS = Number.isFinite(
  RAW_DEFAULT_RALPH_MAX_EXTRA_ITERATIONS,
)
  ? RAW_DEFAULT_RALPH_MAX_EXTRA_ITERATIONS === -1
    ? -1
    : Math.max(0, Math.min(64, RAW_DEFAULT_RALPH_MAX_EXTRA_ITERATIONS))
  : 0;

function applyRuntimeEnv(runtimeEnv: ContainerInput['runtimeEnv']): void {
  for (const [name, value] of Object.entries(runtimeEnv || {})) {
    if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(name)) continue;
    if (typeof value !== 'string' || !value.trim()) continue;
    process.env[name] = value;
  }
}

const approvalRuntime = new TrustedCoworkerApprovalRuntime();
let cachedSelectedSkillPath: string | null = null;

/** Auth material received once via stdin, held in memory for the agent lifetime. */
let storedApiKey = '';
let storedRequestHeaders: Record<string, string> = {};
let storedTaskModels: ContainerInput['taskModels'];
let mcpClientManager: McpClientManager | null = null;
let mcpConfigWatcher: McpConfigWatcher | null = null;
let shutdownPromise: Promise<never> | null = null;

function cloneTaskModels(
  taskModels: ContainerInput['taskModels'],
): ContainerInput['taskModels'] | undefined {
  const cloned: NonNullable<ContainerInput['taskModels']> = {};
  for (const key of TASK_MODEL_KEYS) {
    const taskModel = taskModels?.[key];
    if (!taskModel) continue;
    cloned[key] = {
      ...taskModel,
      requestHeaders: taskModel.requestHeaders
        ? { ...taskModel.requestHeaders }
        : undefined,
    };
  }
  return Object.keys(cloned).length > 0 ? cloned : undefined;
}

function normalizeTaskModelBaseUrl(baseUrl: string | undefined): string {
  return String(baseUrl || '')
    .trim()
    .replace(/\/+$/g, '');
}

function resolveTaskModelsForRequest(
  taskModels: ContainerInput['taskModels'],
): ContainerInput['taskModels'] | undefined {
  if (!taskModels) {
    storedTaskModels = undefined;
    return undefined;
  }

  const merged: NonNullable<ContainerInput['taskModels']> = {};
  for (const key of TASK_MODEL_KEYS) {
    const incomingTaskModel = taskModels[key];
    if (!incomingTaskModel) continue;

    const storedTaskModel = storedTaskModels?.[key];
    const sameRouting =
      !incomingTaskModel.error &&
      String(incomingTaskModel.provider || '') ===
        String(storedTaskModel?.provider || '') &&
      normalizeTaskModelBaseUrl(incomingTaskModel.baseUrl) ===
        normalizeTaskModelBaseUrl(storedTaskModel?.baseUrl) &&
      String(incomingTaskModel.model || '').trim() ===
        String(storedTaskModel?.model || '').trim();

    merged[key] = {
      ...incomingTaskModel,
      apiKey:
        String(incomingTaskModel.apiKey || '').trim() ||
        (sameRouting ? String(storedTaskModel?.apiKey || '').trim() : ''),
      requestHeaders:
        incomingTaskModel.requestHeaders &&
        Object.keys(incomingTaskModel.requestHeaders).length > 0
          ? { ...incomingTaskModel.requestHeaders }
          : sameRouting && storedTaskModel?.requestHeaders
            ? { ...storedTaskModel.requestHeaders }
            : undefined,
    };
  }
  if (Object.keys(merged).length === 0) {
    storedTaskModels = undefined;
    return undefined;
  }
  storedTaskModels = cloneTaskModels(merged);
  return merged;
}

async function syncMcpConfig(
  servers: ContainerInput['mcpServers'],
): Promise<void> {
  const nextServers = servers || {};
  if (!mcpClientManager && Object.keys(nextServers).length === 0) return;
  if (!mcpClientManager) {
    mcpClientManager = new McpClientManager();
    mcpConfigWatcher = new McpConfigWatcher(mcpClientManager);
    setMcpClientManager(mcpClientManager);
  }
  await mcpConfigWatcher?.applyConfig(nextServers);
}

async function shutdownMcp(): Promise<void> {
  mcpConfigWatcher?.stop();
  mcpConfigWatcher = null;
  setMcpClientManager(null);
  if (mcpClientManager) {
    await mcpClientManager.shutdown();
  }
  mcpClientManager = null;
}

async function shutdownAgentProcess(
  exitCode: number,
  reason: string,
  finalOutput?: ContainerOutput,
): Promise<never> {
  if (shutdownPromise) {
    return shutdownPromise;
  }

  shutdownPromise = (async () => {
    console.error(`[hybridclaw-agent] shutting down (${reason})`);
    resetPersistentBashSessions();
    await cleanupAllBrowserSessions().catch((error) => {
      console.error('[hybridclaw-agent] browser cleanup failed:', error);
    });
    await shutdownMcp().catch((error) => {
      console.error('[hybridclaw-agent] MCP shutdown failed:', error);
    });
    if (finalOutput) {
      writeOutput(finalOutput);
    }
    process.exit(exitCode);
  })();
  return shutdownPromise;
}

function normalizePathSlashes(raw: string): string {
  return raw.replace(/\\/g, '/');
}

function parseToolArgs(argsJson: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(argsJson) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function captureSkillSelection(toolName: string, argsJson: string): void {
  if (toolName !== 'read') return;
  const args = parseToolArgs(argsJson);
  const rawPath = String(args?.path || '').trim();
  if (!rawPath) return;
  const normalized = rawPath.replace(/\\/g, '/');
  if (!/(^|\/)skills\/[^/]+\/SKILL\.md$/i.test(normalized)) return;
  cachedSelectedSkillPath = rawPath;
}

function injectSkillCacheHint(messages: ChatMessage[]): ChatMessage[] {
  if (!cachedSelectedSkillPath) return messages;
  const latestPrompt = latestUserPrompt(messages);
  if (!latestPrompt.includes('[Approval already granted]')) return messages;
  if (
    messages.some(
      (message) =>
        message.role === 'system' &&
        normalizeMessageContentToText(message.content).includes(
          '[SkillSelectionCache]',
        ),
    )
  ) {
    return messages;
  }

  return mergeSystemMessage(
    messages,
    [
      '[SkillSelectionCache]',
      `You already selected skill guidance from \`${cachedSelectedSkillPath}\` earlier in this session.`,
      'Reuse that skill now and do not reread the SKILL.md unless the task scope changed or a missing detail requires it.',
    ].join('\n'),
  );
}

/**
 * Read a single line from stdin (the initial request JSON containing secrets).
 * Resolves on the first newline — does not consume the entire stream, so docker -i
 * keeps the container alive after the host stops writing.
 */
function readStdinLine(): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString('utf-8');
      const nl = buffer.indexOf('\n');
      if (nl !== -1) {
        process.stdin.removeListener('data', onData);
        process.stdin.removeListener('error', onError);
        process.stdin.pause();
        resolve(buffer.slice(0, nl));
      }
    };
    const onError = (err: Error) => {
      process.stdin.removeListener('data', onData);
      reject(err);
    };
    process.stdin.on('data', onData);
    process.stdin.on('error', onError);
    process.stdin.resume();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function emitStreamDelta(delta: string): void {
  if (!delta) return;
  const payload = Buffer.from(delta, 'utf-8').toString('base64');
  console.error(`[stream] ${payload}`);
}

function emitStreamActivity(): void {
  console.error('[stream-activity]');
}

function emitApprovalProgress(approval: PendingApproval): void {
  const payload = Buffer.from(JSON.stringify(approval), 'utf-8').toString(
    'base64',
  );
  console.error(`[approval] ${payload}`);
}

function latestUserPrompt(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== 'user') continue;
    const text = normalizeMessageContentToText(message.content)
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) continue;
    return text.slice(0, 1_200);
  }
  return 'Continue the task';
}

function cloneMessageWithTextContent(
  message: ChatMessage,
  text: string,
): ChatMessage {
  if (typeof message.content === 'string' || message.content == null) {
    return {
      ...message,
      content: text,
    };
  }
  return {
    ...message,
    content: [{ type: 'text', text }],
  };
}

function replaceLatestUserPrompt(
  messages: ChatMessage[],
  prompt: string,
): ChatMessage[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== 'user') continue;
    const cloned = messages.map((entry) => ({ ...entry }));
    cloned[i] = cloneMessageWithTextContent(cloned[i], prompt);
    return cloned;
  }
  return [...messages, { role: 'user', content: prompt }];
}

function normalizeRalphMaxExtraIterations(
  value: number | null | undefined,
): number {
  if (!Number.isFinite(value)) return DEFAULT_RALPH_MAX_EXTRA_ITERATIONS;
  const parsed = Math.trunc(value as number);
  if (parsed === -1) return -1;
  return Math.max(0, Math.min(64, parsed));
}

function resolveMaxStalledTurns(ralphMaxExtraIterations: number): number {
  if (ralphMaxExtraIterations === 0) return MAX_STALLED_MODEL_TURNS;
  if (ralphMaxExtraIterations < 0) return Number.MAX_SAFE_INTEGER;
  return Math.max(MAX_STALLED_MODEL_TURNS, ralphMaxExtraIterations + 1);
}

function inferMimeType(filePath: string): string {
  return inferArtifactMimeType(filePath);
}

function normalizeArtifactPath(rawPath: unknown): string | null {
  const value = String(rawPath || '').trim();
  if (!value) return null;

  const workspacePath = resolveWorkspacePath(value);
  if (workspacePath) {
    const relative = path
      .relative(WORKSPACE_ROOT, workspacePath)
      .replace(/\\/g, '/');
    return relative
      ? `${WORKSPACE_ROOT_DISPLAY}/${relative}`
      : WORKSPACE_ROOT_DISPLAY;
  }

  const normalized = normalizePathSlashes(value);
  if (path.posix.isAbsolute(normalized)) return null;
  const clean = path.posix.normalize(normalized);
  if (clean === '..' || clean.startsWith('../')) return null;
  return path.posix.join(WORKSPACE_ROOT_DISPLAY, clean);
}

function extractToolArtifacts(
  toolName: string,
  result: string,
): ArtifactMetadata[] {
  let parsed: Record<string, unknown> | null = null;
  try {
    const value = JSON.parse(result) as unknown;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      parsed = value as Record<string, unknown>;
    }
  } catch {
    return [];
  }

  if (!parsed || parsed.success !== true) return [];
  const artifacts: ArtifactMetadata[] = [];

  const addArtifact = (
    rawPath: unknown,
    rawFilename?: unknown,
    rawMimeType?: unknown,
  ): void => {
    const normalizedPath = normalizeArtifactPath(rawPath);
    if (!normalizedPath) return;
    const filename =
      typeof rawFilename === 'string' && rawFilename.trim()
        ? rawFilename.trim()
        : path.posix.basename(normalizedPath);
    const mimeType =
      typeof rawMimeType === 'string' && rawMimeType.trim()
        ? rawMimeType.trim()
        : inferMimeType(filename || normalizedPath);
    artifacts.push({ path: normalizedPath, filename, mimeType });
  };

  if (Array.isArray(parsed.artifacts)) {
    for (const item of parsed.artifacts) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const entry = item as Record<string, unknown>;
      addArtifact(entry.path, entry.filename, entry.mimeType);
    }
    if (artifacts.length > 0) return artifacts;
  }

  if (toolName === 'browser_screenshot' || toolName === 'browser_pdf') {
    addArtifact(parsed.path);
  }
  return artifacts;
}

function normalizeArtifactKey(filePath: string): string {
  return normalizePathSlashes(filePath).toLowerCase();
}

function collectRequestedArtifacts(params: {
  artifacts: ArtifactMetadata[];
  artifactPaths: Set<string>;
  startedAtMs: number;
}): void {
  const discovered = discoverArtifactsSince(WORKSPACE_ROOT, {
    modifiedAfterMs: Math.max(0, params.startedAtMs - 1_000),
    modifiedBeforeMs: Date.now() + 1_000,
    limit: 8,
  });

  for (const artifact of discovered) {
    const normalizedPath = normalizeArtifactPath(artifact.path);
    if (!normalizedPath) continue;
    const key = normalizeArtifactKey(normalizedPath);
    if (params.artifactPaths.has(key)) continue;
    params.artifactPaths.add(key);
    params.artifacts.push({
      path: normalizedPath,
      filename: artifact.filename,
      mimeType: artifact.mimeType,
    });
  }
}

interface PreparedToolCallExecution {
  call: ToolCall;
  approval: ToolApprovalEvaluation;
}

interface CompletedToolCallExecution {
  toolName: string;
  argsJson: string;
  result: string;
  isError: boolean;
  succeeded: boolean;
  execution: ToolExecution;
  historyMessage: ChatMessage;
  artifacts: ArtifactMetadata[];
}

function logToolCallStart(
  toolName: string,
  argsJson: string,
  approval: ToolApprovalEvaluation,
): void {
  const toolPreview =
    approval.tier === 'yellow'
      ? approvalRuntime.formatYellowNarration(approval)
      : argsJson.slice(0, 100);
  console.error(`[tool] ${toolName}: ${toolPreview}`);
}

function appendCompletedToolCall(params: {
  completed: CompletedToolCallExecution;
  toolsUsed: string[];
  toolExecutions: ToolExecution[];
  history: ChatMessage[];
  toolCallHistory: ToolCallHistoryEntry[];
  artifacts: ArtifactMetadata[];
  artifactPaths: Set<string>;
}): void {
  params.toolsUsed.push(params.completed.toolName);
  params.toolExecutions.push(params.completed.execution);
  for (const artifact of params.completed.artifacts) {
    const artifactKey = normalizeArtifactKey(artifact.path);
    if (params.artifactPaths.has(artifactKey)) continue;
    params.artifactPaths.add(artifactKey);
    params.artifacts.push(artifact);
  }
  params.history.push(params.completed.historyMessage);
  recordToolCallOutcome(
    params.toolCallHistory,
    params.completed.toolName,
    params.completed.argsJson,
    params.completed.result,
    params.completed.isError,
  );
}

function buildContextOverflowOutput(params: {
  latestVisibleAssistantText: string | null;
  toolsUsed: string[];
  artifacts: ArtifactMetadata[];
  toolExecutions: ToolExecution[];
  tokenUsage: ReturnType<typeof finalizeTokenUsage>;
  effectiveUserPrompt: string;
}): ContainerOutput {
  const overflowMessage =
    'Context window exhausted inside the container tool loop after repeated in-loop compaction attempts. Compact or reset the session and retry.';
  if (params.latestVisibleAssistantText) {
    return {
      status: 'success',
      result: `${params.latestVisibleAssistantText}\n\n[${overflowMessage}]`,
      toolsUsed: [...new Set(params.toolsUsed)],
      ...(params.artifacts.length > 0 ? { artifacts: params.artifacts } : {}),
      toolExecutions: params.toolExecutions,
      tokenUsage: params.tokenUsage,
      effectiveUserPrompt: params.effectiveUserPrompt,
    };
  }
  return {
    status: 'error',
    result: null,
    toolsUsed: [...new Set(params.toolsUsed)],
    ...(params.artifacts.length > 0 ? { artifacts: params.artifacts } : {}),
    toolExecutions: params.toolExecutions,
    tokenUsage: params.tokenUsage,
    error: overflowMessage,
    effectiveUserPrompt: params.effectiveUserPrompt,
  };
}

async function executePreparedToolCall(
  prepared: PreparedToolCallExecution,
  toolCallHistory: ToolCallHistoryEntry[],
): Promise<CompletedToolCallExecution> {
  const { call, approval } = prepared;
  const toolName = call.function.name;
  const argsJson = call.function.arguments;
  const toolStart = Date.now();

  if (
    approval.tier === 'yellow' &&
    approval.implicitDelayMs &&
    approval.implicitDelayMs > 0
  ) {
    await sleep(approval.implicitDelayMs);
  }

  const blockedReason = await runBeforeToolHooks(toolName, argsJson);
  const loopGuard = blockedReason
    ? { stuck: false as const }
    : detectToolCallLoop(toolCallHistory, toolName, argsJson);
  const runtimeResult = blockedReason
    ? {
        output: `Tool blocked by security hook: ${blockedReason}`,
        isError: true,
      }
    : loopGuard.stuck
      ? {
          output: loopGuard.message,
          isError: true,
        }
      : await executeToolWithMetadata(toolName, argsJson);
  const toolDuration = Date.now() - toolStart;
  const result = runtimeResult.output;
  const isError = runtimeResult.isError;
  const executionBlockedReason =
    blockedReason || (loopGuard.stuck ? loopGuard.message : null);
  const succeeded = !isError;

  if (succeeded) {
    captureSkillSelection(toolName, argsJson);
  }
  approvalRuntime.afterToolExecution(approval, succeeded);
  if (!executionBlockedReason) {
    await runAfterToolHooks(toolName, argsJson, result);
  }

  console.error(
    `[tool] ${toolName} result (${toolDuration}ms): ${result.slice(0, 100)}`,
  );

  return {
    toolName,
    argsJson,
    result,
    isError,
    succeeded,
    execution: {
      name: toolName,
      arguments: argsJson,
      result,
      durationMs: toolDuration,
      isError,
      blocked: Boolean(executionBlockedReason),
      blockedReason: executionBlockedReason || undefined,
      approvalTier: approval.tier,
      approvalBaseTier: approval.baseTier,
      approvalDecision: executionBlockedReason ? 'denied' : approval.decision,
      approvalActionKey: approval.actionKey,
      approvalReason: approval.reason,
      approvalRequestId: approval.requestId,
      approvalExpiresAt: approval.expiresAtMs,
    },
    historyMessage: { role: 'tool', content: result, tool_call_id: call.id },
    artifacts: extractToolArtifacts(toolName, result),
  };
}

async function callHybridAIWithRetry(params: {
  provider?:
    | 'hybridai'
    | 'openai-codex'
    | 'anthropic'
    | 'openrouter'
    | 'mistral'
    | 'huggingface'
    | 'ollama'
    | 'lmstudio'
    | 'llamacpp'
    | 'vllm';
  baseUrl: string;
  apiKey: string;
  model: string;
  chatbotId: string;
  enableRag: boolean;
  requestHeaders?: Record<string, string>;
  history: ChatMessage[];
  tools: ToolDefinition[];
  onTextDelta?: (delta: string) => void;
  onActivity?: () => void;
  maxTokens?: number;
  isLocal?: boolean;
  contextWindow?: number;
  thinkingFormat?: 'qwen';
}): Promise<ChatCompletionResponse> {
  const {
    provider,
    baseUrl,
    apiKey,
    model,
    chatbotId,
    enableRag,
    requestHeaders,
    history,
    tools,
    onTextDelta,
    onActivity,
    maxTokens,
    isLocal,
    contextWindow,
    thinkingFormat,
  } = params;
  let attempt = 0;
  let delayMs = RETRY_BASE_DELAY_MS;

  while (true) {
    attempt += 1;
    const attemptStartedAt = Date.now();
    console.error(
      `[model] call start provider=${provider || 'hybridai'} model=${model} attempt=${attempt} streaming=${Boolean(onTextDelta)} messages=${history.length} tools=${tools.length}`,
    );
    await emitRuntimeEvent({ event: 'before_model_call', attempt });
    try {
      let response: ChatCompletionResponse;
      if (onTextDelta) {
        try {
          response = await callRoutedModelStream({
            provider,
            baseUrl,
            apiKey,
            model,
            chatbotId,
            enableRag,
            requestHeaders,
            messages: history,
            tools,
            onTextDelta,
            onActivity,
            maxTokens,
            isLocal,
            contextWindow,
            thinkingFormat,
          });
        } catch (streamErr) {
          const fallbackEligible = shouldDowngradeStreamToNonStreaming(
            provider,
            streamErr,
          );
          if (!fallbackEligible) throw streamErr;
          response = await callRoutedModel({
            provider,
            baseUrl,
            apiKey,
            model,
            chatbotId,
            enableRag,
            requestHeaders,
            messages: history,
            tools,
            maxTokens,
            isLocal,
            contextWindow,
            thinkingFormat,
          });
        }
      } else {
        response = await callRoutedModel({
          provider,
          baseUrl,
          apiKey,
          model,
          chatbotId,
          enableRag,
          requestHeaders,
          messages: history,
          tools,
          maxTokens,
          isLocal,
          contextWindow,
          thinkingFormat,
        });
      }
      console.error(
        `[model] call success provider=${provider || 'hybridai'} model=${model} attempt=${attempt} durationMs=${Date.now() - attemptStartedAt} toolCalls=${response.choices[0]?.message?.tool_calls?.length || 0}`,
      );
      await emitRuntimeEvent({
        event: 'after_model_call',
        attempt,
        toolCallCount: response.choices[0]?.message?.tool_calls?.length || 0,
      });
      return response;
    } catch (err) {
      const formattedError = formatModelErrorForLog(err, baseUrl);
      const retryable =
        RETRY_ENABLED &&
        isRetryableModelError(err) &&
        attempt < RETRY_MAX_ATTEMPTS;
      await emitRuntimeEvent({
        event: retryable ? 'model_retry' : 'model_error',
        attempt,
        retryable,
        error: formattedError,
      });
      console.error(
        `[model] call ${retryable ? 'retry' : 'error'} provider=${provider || 'hybridai'} model=${model} attempt=${attempt} durationMs=${Date.now() - attemptStartedAt} retryable=${retryable} error=${formattedError}`,
      );
      if (!retryable) throw err;
      await sleep(delayMs);
      delayMs = Math.min(delayMs * 2, RETRY_MAX_DELAY_MS);
    }
  }
}

/**
 * Process a single request: call API, run tool loop, write output.
 */
async function processRequest(
  messages: ChatMessage[],
  apiKey: string,
  baseUrl: string,
  provider:
    | 'hybridai'
    | 'openai-codex'
    | 'anthropic'
    | 'openrouter'
    | 'mistral'
    | 'huggingface'
    | 'ollama'
    | 'lmstudio'
    | 'llamacpp'
    | 'vllm'
    | undefined,
  isLocal: boolean | undefined,
  contextWindow: number | undefined,
  thinkingFormat: 'qwen' | undefined,
  model: string,
  chatbotId: string,
  enableRag: boolean,
  requestHeaders: Record<string, string> | undefined,
  tools: ToolDefinition[],
  taskModels: ContainerInput['taskModels'] | undefined,
  contextGuard: ContainerInput['contextGuard'] | undefined,
  channelId: string,
  skipContainerSystemPrompt = false,
  streamTextDeltas = false,
  maxTokens?: number,
  effectiveUserPromptOverride?: string,
  ralphMaxIterationsOverride?: number | null,
): Promise<ContainerOutput> {
  const processStartedAt = Date.now();
  await emitRuntimeEvent({
    event: 'before_agent_start',
    messageCount: messages.length,
  });
  let history: ChatMessage[] = collapseSystemMessages(
    skipContainerSystemPrompt
      ? messages
      : injectRuntimeCapabilitiesMessage(messages),
  );
  const toolsUsed: string[] = [];
  const toolExecutions: ToolExecution[] = [];
  const toolCallHistory: ToolCallHistoryEntry[] = [];
  const artifacts: ArtifactMetadata[] = [];
  const artifactPaths = new Set<string>();
  const tokenUsage = createTokenUsageStats();
  const effectiveUserPrompt =
    effectiveUserPromptOverride || latestUserPrompt(messages);
  const ralphMaxExtraIterations = normalizeRalphMaxExtraIterations(
    ralphMaxIterationsOverride,
  );
  const ralphEnabled = ralphMaxExtraIterations !== 0;
  const ralphSeedPrompt = ralphEnabled ? effectiveUserPrompt : '';
  const maxStalledTurns = resolveMaxStalledTurns(ralphMaxExtraIterations);
  let ralphExtraIterations = 0;
  let stalledTurns = 0;
  let latestVisibleAssistantText: string | null = null;
  let compactionRetries = 0;
  const tokenEstimateCache = createTokenEstimateCache();
  const maxContextGuardRetries = Math.max(0, contextGuard?.maxRetries ?? 3);

  while (stalledTurns < maxStalledTurns) {
    const guardResult = applyContextGuard({
      history,
      contextWindowTokens: contextWindow,
      config: contextGuard,
      cache: tokenEstimateCache,
    });
    if (
      guardResult.truncatedToolResults > 0 ||
      guardResult.compactedToolResults > 0
    ) {
      console.error(
        `[context] guard adjusted history truncated=${guardResult.truncatedToolResults} compacted=${guardResult.compactedToolResults} totalTokens=${guardResult.totalTokensAfter}/${guardResult.overflowBudgetTokens}`,
      );
    }
    if (guardResult.tier3Triggered) {
      if (compactionRetries >= maxContextGuardRetries) {
        const overflow = buildContextOverflowOutput({
          latestVisibleAssistantText,
          toolsUsed,
          artifacts,
          toolExecutions,
          tokenUsage: finalizeTokenUsage(tokenUsage),
          effectiveUserPrompt,
        });
        await emitRuntimeEvent({
          event: 'turn_end',
          status: overflow.status,
          toolsUsed: overflow.toolsUsed,
        });
        return overflow;
      }

      const compacted = await compactInLoop({
        history,
        contextWindowTokens: contextWindow,
        summarize: async (summaryMessages, summaryMaxTokens) => {
          tokenUsage.modelCalls += 1;
          tokenUsage.estimatedPromptTokens +=
            estimateMessageTokens(summaryMessages);
          const response = await callAuxiliaryModel({
            task: 'compression',
            taskModels,
            fallbackContext: {
              provider,
              baseUrl,
              apiKey,
              model,
              chatbotId,
              requestHeaders,
              isLocal,
              contextWindow,
              thinkingFormat,
            },
            messages: summaryMessages,
            maxTokens: summaryMaxTokens,
            toolName: 'in_loop_compaction',
          });
          accumulateApiUsage(tokenUsage, response.response);
          tokenUsage.estimatedCompletionTokens += estimateTextTokens(
            response.content,
          );
          return response.content;
        },
      });
      if (!compacted.changed) {
        const overflow = buildContextOverflowOutput({
          latestVisibleAssistantText,
          toolsUsed,
          artifacts,
          toolExecutions,
          tokenUsage: finalizeTokenUsage(tokenUsage),
          effectiveUserPrompt,
        });
        await emitRuntimeEvent({
          event: 'turn_end',
          status: overflow.status,
          toolsUsed: overflow.toolsUsed,
        });
        return overflow;
      }
      history = compacted.history;
      compactionRetries += 1;
      console.error(
        `[context] in-loop compaction retry=${compactionRetries} compactedMessages=${compacted.compactedMessages} summarySource=${compacted.summarySource}`,
      );
      continue;
    }

    tokenUsage.modelCalls += 1;
    tokenUsage.estimatedPromptTokens += estimateMessageTokens(
      history,
      tokenEstimateCache,
    );

    let response: Awaited<ReturnType<typeof callHybridAIWithRetry>>;
    try {
      response = await callHybridAIWithRetry({
        provider,
        baseUrl,
        apiKey,
        model,
        chatbotId,
        enableRag,
        requestHeaders,
        history,
        tools,
        onTextDelta: streamTextDeltas ? emitStreamDelta : undefined,
        onActivity: streamTextDeltas ? emitStreamActivity : undefined,
        maxTokens,
        isLocal,
        contextWindow,
        thinkingFormat,
      });
    } catch (err) {
      const failed: ContainerOutput = {
        status: 'error',
        result: null,
        toolsUsed,
        ...(artifacts.length > 0 ? { artifacts } : {}),
        toolExecutions,
        tokenUsage: finalizeTokenUsage(tokenUsage),
        error:
          err instanceof ProviderRequestError
            ? err.message
            : `API error: ${err instanceof Error ? err.message : String(err)}`,
      };
      await emitRuntimeEvent({
        event: 'turn_end',
        status: failed.status,
        toolsUsed,
      });
      return failed;
    }

    accumulateApiUsage(tokenUsage, response);

    const choice = response.choices[0];
    if (!choice) {
      const failed: ContainerOutput = {
        status: 'error',
        result: null,
        toolsUsed,
        ...(artifacts.length > 0 ? { artifacts } : {}),
        toolExecutions,
        tokenUsage: finalizeTokenUsage(tokenUsage),
        error: 'No response from API',
      };
      await emitRuntimeEvent({
        event: 'turn_end',
        status: failed.status,
        toolsUsed,
      });
      return failed;
    }

    tokenUsage.estimatedCompletionTokens += estimateTextTokens(
      choice.message.content,
    );
    if (choice.message.tool_calls?.length) {
      tokenUsage.estimatedCompletionTokens += estimateTextTokens(
        JSON.stringify(choice.message.tool_calls),
      );
    }

    const toolCalls = choice.message.tool_calls || [];
    const invalidToolCallError = validateStructuredToolCalls(toolCalls);
    if (invalidToolCallError) {
      console.error(
        `[model] invalid structured tool call provider=${provider || 'hybridai'} model=${model} error=${invalidToolCallError}`,
      );
      const failed: ContainerOutput = {
        status: 'error',
        result: null,
        toolsUsed,
        ...(artifacts.length > 0 ? { artifacts } : {}),
        toolExecutions,
        tokenUsage: finalizeTokenUsage(tokenUsage),
        error: invalidToolCallError,
        effectiveUserPrompt,
      };
      await emitRuntimeEvent({
        event: 'turn_end',
        status: failed.status,
        toolsUsed,
      });
      return failed;
    }

    const assistantMessage: ChatMessage = {
      role: 'assistant',
      content: choice.message.content,
    };

    if (choice.message.tool_calls && choice.message.tool_calls.length > 0) {
      assistantMessage.tool_calls = choice.message.tool_calls;
    }

    history.push(assistantMessage);
    const visibleAssistantText = stripRalphChoiceTags(choice.message.content);
    if (visibleAssistantText) {
      latestVisibleAssistantText = visibleAssistantText;
    }
    if (
      provider === 'hybridai' &&
      parseRalphChoice(choice.message.content) === null &&
      isHybridAIEmptyVisibleCompletion(response)
    ) {
      console.error(
        `[model] empty completion provider=hybridai model=${model} debug=${summarizeHybridAICompletionForDebug(response)}`,
      );
      const failed: ContainerOutput = {
        status: 'error',
        result: null,
        toolsUsed,
        ...(artifacts.length > 0 ? { artifacts } : {}),
        toolExecutions,
        tokenUsage: finalizeTokenUsage(tokenUsage),
        error:
          'HybridAI returned an empty completion without visible text or tool calls.',
        effectiveUserPrompt,
      };
      await emitRuntimeEvent({
        event: 'turn_end',
        status: failed.status,
        toolsUsed,
      });
      return failed;
    }
    if (toolCalls.length === 0) {
      if (ralphEnabled) {
        const branchChoice = parseRalphChoice(choice.message.content);
        if (branchChoice === 'STOP') {
          collectRequestedArtifacts({
            artifacts,
            artifactPaths,
            startedAtMs: processStartedAt,
          });
          const completed: ContainerOutput = {
            status: 'success',
            result: latestVisibleAssistantText,
            toolsUsed: [...new Set(toolsUsed)],
            ...(artifacts.length > 0 ? { artifacts } : {}),
            toolExecutions,
            tokenUsage: finalizeTokenUsage(tokenUsage),
            effectiveUserPrompt,
          };
          await emitRuntimeEvent({
            event: 'turn_end',
            status: completed.status,
            toolsUsed: completed.toolsUsed,
          });
          return completed;
        }

        const canContinue =
          ralphMaxExtraIterations < 0 ||
          ralphExtraIterations < ralphMaxExtraIterations;
        if (canContinue) {
          ralphExtraIterations += 1;
          stalledTurns = advanceStalledTurnCount({
            current: stalledTurns,
            toolCalls: 0,
            successfulToolCalls: 0,
          });
          history.push({
            role: 'user',
            content: buildRalphPrompt(ralphSeedPrompt, branchChoice == null),
          });
          console.error(
            `[ralph] continue ${ralphExtraIterations}` +
              (ralphMaxExtraIterations < 0
                ? ''
                : `/${ralphMaxExtraIterations}`),
          );
          continue;
        }
      }

      collectRequestedArtifacts({
        artifacts,
        artifactPaths,
        startedAtMs: processStartedAt,
      });
      const completed: ContainerOutput = {
        status: 'success',
        result: latestVisibleAssistantText,
        toolsUsed: [...new Set(toolsUsed)],
        ...(artifacts.length > 0 ? { artifacts } : {}),
        toolExecutions,
        tokenUsage: finalizeTokenUsage(tokenUsage),
        effectiveUserPrompt,
      };
      await emitRuntimeEvent({
        event: 'turn_end',
        status: completed.status,
        toolsUsed: completed.toolsUsed,
      });
      return completed;
    }

    let successfulToolCallsThisTurn = 0;
    const allowConcurrentBatching =
      toolCalls.length > 1 &&
      toolCalls.every(
        (entry) =>
          getToolExecutionMode(
            entry.function.name,
            entry.function.arguments,
          ) === 'parallel',
      );
    const cachedApprovals = new Map<string, ToolApprovalEvaluation>();
    for (let callIndex = 0; callIndex < toolCalls.length; ) {
      const call = toolCalls[callIndex];
      const toolName = call.function.name;
      const cachedApproval = takeCachedValue(cachedApprovals, call.id);
      const executionMode =
        cachedApproval || !allowConcurrentBatching ? 'sequential' : 'parallel';

      if (executionMode === 'parallel') {
        const candidateCalls: ToolCall[] = [call];
        let nextOffset = 1;
        while (
          callIndex + nextOffset < toolCalls.length &&
          candidateCalls.length < MAX_PARALLEL_TOOL_CALLS
        ) {
          const candidate = toolCalls[callIndex + nextOffset];
          if (
            getToolExecutionMode(
              candidate.function.name,
              candidate.function.arguments,
            ) !== 'parallel'
          ) {
            break;
          }
          candidateCalls.push(candidate);
          nextOffset += 1;
        }

        const preparedBatch: PreparedToolCallExecution[] = [];
        for (const candidate of candidateCalls) {
          const candidateApproval = approvalRuntime.evaluateToolCall({
            toolName: candidate.function.name,
            argsJson: candidate.function.arguments,
            latestUserPrompt: effectiveUserPrompt,
            channelId,
          });
          if (
            candidateApproval.decision === 'required' ||
            candidateApproval.decision === 'denied'
          ) {
            cachedApprovals.set(candidate.id, candidateApproval);
            break;
          }
          logToolCallStart(
            candidate.function.name,
            candidate.function.arguments,
            candidateApproval,
          );
          preparedBatch.push({
            call: candidate,
            approval: candidateApproval,
          });
        }

        if (preparedBatch.length >= 1) {
          const draftToolCallHistory = toolCallHistory.map((entry) => ({
            ...entry,
          }));
          let guardedSequence = Promise.resolve();
          if (preparedBatch.length > 1) {
            console.error(
              `[tool] running ${preparedBatch.length} tool calls concurrently`,
            );
          }
          const completedBatch = await mapConcurrentInOrder(
            preparedBatch,
            async (prepared) => {
              const batchToolName = prepared.call.function.name;
              if (!isLoopGuardedToolName(batchToolName)) {
                return executePreparedToolCall(prepared, toolCallHistory);
              }

              const priorGuarded = guardedSequence;
              let releaseGuarded = (): void => {};
              guardedSequence = new Promise<void>((resolve) => {
                releaseGuarded = resolve;
              });

              await priorGuarded;
              try {
                const completed = await executePreparedToolCall(
                  prepared,
                  draftToolCallHistory,
                );
                recordToolCallOutcome(
                  draftToolCallHistory,
                  completed.toolName,
                  completed.argsJson,
                  completed.result,
                  completed.isError,
                );
                return completed;
              } finally {
                releaseGuarded();
              }
            },
          );
          for (const completed of completedBatch) {
            if (completed.succeeded) {
              successfulToolCallsThisTurn += 1;
            }
            appendCompletedToolCall({
              completed,
              toolsUsed,
              toolExecutions,
              history,
              toolCallHistory,
              artifacts,
              artifactPaths,
            });
          }
          callIndex += preparedBatch.length;
          continue;
        }
      }

      const approval =
        cachedApproval ||
        approvalRuntime.evaluateToolCall({
          toolName,
          argsJson: call.function.arguments,
          latestUserPrompt: effectiveUserPrompt,
          channelId,
        });
      logToolCallStart(toolName, call.function.arguments, approval);

      if (approval.decision === 'required') {
        toolsUsed.push(toolName);
        if (!approval.requestId) {
          throw new Error(
            'Approval-required tool call is missing a request id.',
          );
        }
        const prompt = approvalRuntime.formatApprovalRequest(approval);
        const pendingApproval: PendingApproval = {
          approvalId: approval.requestId,
          prompt,
          intent: approval.intent,
          reason: approval.reason,
          allowSession: !approval.pinned,
          allowAgent: !approval.pinned,
          allowAll: !approval.pinned,
          expiresAt:
            typeof approval.expiresAtMs === 'number' &&
            Number.isFinite(approval.expiresAtMs)
              ? approval.expiresAtMs
              : null,
        };
        emitApprovalProgress(pendingApproval);
        toolExecutions.push({
          name: toolName,
          arguments: call.function.arguments,
          result: prompt,
          durationMs: 0,
          isError: false,
          blocked: true,
          blockedReason: approval.reason,
          approvalTier: approval.tier,
          approvalBaseTier: approval.baseTier,
          approvalDecision: approval.decision,
          approvalActionKey: approval.actionKey,
          approvalIntent: approval.intent,
          approvalReason: approval.reason,
          approvalRequestId: approval.requestId,
          approvalExpiresAt: approval.expiresAtMs,
          approvalAllowSession: !approval.pinned,
          approvalAllowAgent: !approval.pinned,
          approvalAllowAll: !approval.pinned,
        });
        const waitingForApproval: ContainerOutput = {
          status: 'success',
          result: prompt,
          toolsUsed: [...new Set(toolsUsed)],
          ...(artifacts.length > 0 ? { artifacts } : {}),
          toolExecutions,
          pendingApproval,
          tokenUsage: finalizeTokenUsage(tokenUsage),
          effectiveUserPrompt,
        };
        await emitRuntimeEvent({
          event: 'turn_end',
          status: waitingForApproval.status,
          toolsUsed: waitingForApproval.toolsUsed,
        });
        return waitingForApproval;
      }

      if (approval.decision === 'denied') {
        toolsUsed.push(toolName);
        const denialText = `Approval denied: ${approval.reason}`;
        toolExecutions.push({
          name: toolName,
          arguments: call.function.arguments,
          result: denialText,
          durationMs: 0,
          isError: true,
          blocked: true,
          blockedReason: approval.reason,
          approvalTier: approval.tier,
          approvalBaseTier: approval.baseTier,
          approvalDecision: approval.decision,
          approvalActionKey: approval.actionKey,
          approvalIntent: approval.intent,
          approvalReason: approval.reason,
          approvalRequestId: approval.requestId,
          approvalExpiresAt: approval.expiresAtMs,
          approvalAllowSession: !approval.pinned,
          approvalAllowAgent: !approval.pinned,
        });
        const denied: ContainerOutput = {
          status: 'success',
          result: denialText,
          toolsUsed: [...new Set(toolsUsed)],
          ...(artifacts.length > 0 ? { artifacts } : {}),
          toolExecutions,
          tokenUsage: finalizeTokenUsage(tokenUsage),
          effectiveUserPrompt,
        };
        await emitRuntimeEvent({
          event: 'turn_end',
          status: denied.status,
          toolsUsed: denied.toolsUsed,
        });
        return denied;
      }

      const completed = await executePreparedToolCall(
        {
          call,
          approval,
        },
        toolCallHistory,
      );
      if (completed.succeeded) {
        successfulToolCallsThisTurn += 1;
      }
      appendCompletedToolCall({
        completed,
        toolsUsed,
        toolExecutions,
        history,
        toolCallHistory,
        artifacts,
        artifactPaths,
      });
      callIndex += 1;
    }
    stalledTurns = advanceStalledTurnCount({
      current: stalledTurns,
      toolCalls: toolCalls.length,
      successfulToolCalls: successfulToolCallsThisTurn,
    });
  }

  collectRequestedArtifacts({
    artifacts,
    artifactPaths,
    startedAtMs: processStartedAt,
  });
  const completed: ContainerOutput = {
    status: 'success',
    result:
      latestVisibleAssistantText ||
      `No successful tool progress for ${maxStalledTurns} consecutive model turns.`,
    toolsUsed: [...new Set(toolsUsed)],
    ...(artifacts.length > 0 ? { artifacts } : {}),
    toolExecutions,
    tokenUsage: finalizeTokenUsage(tokenUsage),
    effectiveUserPrompt,
  };
  await emitRuntimeEvent({
    event: 'turn_end',
    status: completed.status,
    toolsUsed: completed.toolsUsed,
  });
  return completed;
}

/**
 * Main loop: read first request from stdin (with secrets), then poll IPC for follow-ups.
 */
function resolveTools(input: ContainerInput): ToolDefinition[] {
  const mcpTools = mcpClientManager?.getAllToolDefinitions() || [];
  const dynamicPluginTools = getPluginToolDefinitions();
  let tools = [...TOOL_DEFINITIONS, ...dynamicPluginTools, ...mcpTools];
  if (input.allowedTools) {
    const allowed = new Set(input.allowedTools);
    tools = tools.filter((tool) => allowed.has(tool.function.name));
  }
  if (Array.isArray(input.blockedTools) && input.blockedTools.length > 0) {
    const blocked = new Set(
      input.blockedTools
        .map((name) => String(name || '').trim())
        .filter(Boolean),
    );
    tools = tools.filter((tool) => !blocked.has(tool.function.name));
  }
  tools = tools.map((tool) => {
    if (tool.function.name !== 'message') return tool;
    return {
      ...tool,
      function: {
        ...tool.function,
        description: getMessageToolDescription(
          input.channelId,
          input.activeMessageChannels,
        ),
      },
    };
  });
  // Sort alphabetically for deterministic tool ordering (request/cache stability)
  tools.sort((a, b) => a.function.name.localeCompare(b.function.name));
  return tools;
}

async function main(): Promise<void> {
  console.error(
    `[hybridclaw-agent] started, idle timeout ${IDLE_TIMEOUT_MS}ms`,
  );
  process.once('SIGINT', () => {
    void shutdownAgentProcess(0, 'SIGINT');
  });
  process.once('SIGTERM', () => {
    void shutdownAgentProcess(0, 'SIGTERM');
  });

  // First request arrives via stdin (contains apiKey — never written to disk)
  const stdinData = await readStdinLine();
  const firstInput: ContainerInput = JSON.parse(stdinData);
  applyRuntimeEnv(firstInput.runtimeEnv);
  storedApiKey = firstInput.apiKey;
  storedRequestHeaders = { ...(firstInput.requestHeaders || {}) };
  const firstTaskModels = resolveTaskModelsForRequest(firstInput.taskModels);

  console.error(
    `[hybridclaw-agent] processing first request (${firstInput.messages.length} messages)`,
  );

  await syncMcpConfig(firstInput.mcpServers);
  resetSideEffects();
  setScheduledTasks(firstInput.scheduledTasks);
  setSessionContext(firstInput.sessionId);
  setPersistentBashStateEnabled(firstInput.persistBashState !== false);
  setPluginTools(firstInput.pluginTools);
  setGatewayContext(
    firstInput.gatewayBaseUrl,
    firstInput.gatewayApiToken,
    firstInput.channelId,
    firstInput.configuredDiscordChannels,
  );
  setWebSearchConfig(firstInput.webSearch);
  setModelContext(
    firstInput.provider,
    firstInput.baseUrl,
    storedApiKey,
    firstInput.model,
    firstInput.chatbotId,
    storedRequestHeaders,
    firstInput.maxTokens,
  );
  setTaskModelPolicies(firstTaskModels);
  setMediaContext(firstInput.media);
  const firstVisionMessages = await injectNativeVisionContent({
    messages: firstInput.messages,
    model: firstInput.model,
    media: firstInput.media,
  });
  const firstMessages = await injectNativeAudioContent({
    messages: firstVisionMessages,
    provider: firstInput.provider,
    media: firstInput.media,
    audioTranscriptsPrepended: firstInput.audioTranscriptsPrepended,
  });
  const firstPrelude = approvalRuntime.handleApprovalResponse(firstMessages);
  const firstPromptOverride = firstPrelude?.replayPrompt;
  const firstPreparedMessages = firstPromptOverride
    ? replaceLatestUserPrompt(firstMessages, firstPromptOverride)
    : firstMessages;
  const firstMessagesForRequest = injectSkillCacheHint(firstPreparedMessages);
  approvalRuntime.setFullAutoOptions({
    enabled: firstInput.fullAutoEnabled === true,
    neverApproveTools: firstInput.fullAutoNeverApproveTools,
  });

  let firstOutput: ContainerOutput;
  if (firstPrelude?.immediateMessage && !firstPromptOverride) {
    firstOutput = {
      status: 'success',
      result: firstPrelude.immediateMessage,
      toolsUsed: [],
      toolExecutions: [],
      effectiveUserPrompt: latestUserPrompt(firstMessagesForRequest),
    };
    console.error('[approval] resolved user response without model run');
  } else {
    firstOutput = await processRequest(
      firstMessagesForRequest,
      storedApiKey,
      firstInput.baseUrl,
      firstInput.provider,
      firstInput.isLocal,
      firstInput.contextWindow,
      firstInput.thinkingFormat,
      firstInput.model,
      firstInput.chatbotId,
      firstInput.enableRag,
      storedRequestHeaders,
      resolveTools(firstInput),
      firstTaskModels,
      firstInput.contextGuard,
      firstInput.channelId,
      firstInput.skipContainerSystemPrompt === true,
      firstInput.streamTextDeltas === true,
      firstInput.maxTokens,
      firstPromptOverride,
      firstInput.ralphMaxIterations,
    );
    if (
      firstMessagesForRequest !== firstInput.messages &&
      firstOutput.status === 'error' &&
      shouldRetryWithoutNativeMedia(firstOutput.error)
    ) {
      console.error(
        '[media] native media injection rejected by model; retrying without native media parts',
      );
      const firstRetryMessages = firstPromptOverride
        ? replaceLatestUserPrompt(firstInput.messages, firstPromptOverride)
        : firstInput.messages;
      const firstRetryMessagesWithSkillCache =
        injectSkillCacheHint(firstRetryMessages);
      firstOutput = await processRequest(
        firstRetryMessagesWithSkillCache,
        storedApiKey,
        firstInput.baseUrl,
        firstInput.provider,
        firstInput.isLocal,
        firstInput.contextWindow,
        firstInput.thinkingFormat,
        firstInput.model,
        firstInput.chatbotId,
        firstInput.enableRag,
        firstInput.requestHeaders,
        resolveTools(firstInput),
        firstTaskModels,
        firstInput.contextGuard,
        firstInput.channelId,
        firstInput.skipContainerSystemPrompt === true,
        firstInput.streamTextDeltas === true,
        firstInput.maxTokens,
        firstPromptOverride,
        firstInput.ralphMaxIterations,
      );
    }
  }

  firstOutput.sideEffects = getPendingSideEffects();
  writeOutput(firstOutput);
  console.error(
    `[hybridclaw-agent] first request complete: ${firstOutput.status}`,
  );

  // Subsequent requests come via IPC file polling
  while (true) {
    const input = await waitForInput(IDLE_TIMEOUT_MS);

    if (!input) {
      console.error('[hybridclaw-agent] idle timeout, exiting');
      await shutdownAgentProcess(0, 'idle timeout');
      return;
    }

    applyRuntimeEnv(input.runtimeEnv);

    // Use stored apiKey — IPC file no longer contains it
    const apiKey = input.apiKey || storedApiKey;
    const requestHeaders =
      input.requestHeaders && Object.keys(input.requestHeaders).length > 0
        ? input.requestHeaders
        : storedRequestHeaders;
    if (input.apiKey) storedApiKey = input.apiKey;
    if (input.requestHeaders && Object.keys(input.requestHeaders).length > 0) {
      storedRequestHeaders = { ...input.requestHeaders };
    }
    const taskModels = resolveTaskModelsForRequest(input.taskModels);

    console.error(
      `[hybridclaw-agent] processing request (${input.messages.length} messages)`,
    );

    await syncMcpConfig(input.mcpServers);
    resetSideEffects();
    setScheduledTasks(input.scheduledTasks);
    setSessionContext(input.sessionId);
    setPersistentBashStateEnabled(input.persistBashState !== false);
    setPluginTools(input.pluginTools);
    setGatewayContext(
      input.gatewayBaseUrl,
      input.gatewayApiToken,
      input.channelId,
      input.configuredDiscordChannels,
    );
    setWebSearchConfig(input.webSearch);
    setModelContext(
      input.provider,
      input.baseUrl,
      apiKey,
      input.model,
      input.chatbotId,
      requestHeaders,
      input.maxTokens,
    );
    setTaskModelPolicies(taskModels);
    setMediaContext(input.media);
    const visionPreparedMessages = await injectNativeVisionContent({
      messages: input.messages,
      model: input.model,
      media: input.media,
    });
    const preparedMessages = await injectNativeAudioContent({
      messages: visionPreparedMessages,
      provider: input.provider,
      media: input.media,
      audioTranscriptsPrepended: input.audioTranscriptsPrepended,
    });
    approvalRuntime.setFullAutoOptions({
      enabled: input.fullAutoEnabled === true,
      neverApproveTools: input.fullAutoNeverApproveTools,
    });
    const prelude = approvalRuntime.handleApprovalResponse(preparedMessages);
    const promptOverride = prelude?.replayPrompt;
    const messagesForRequest = promptOverride
      ? replaceLatestUserPrompt(preparedMessages, promptOverride)
      : preparedMessages;
    const messagesForRequestWithSkillCache =
      injectSkillCacheHint(messagesForRequest);

    if (prelude?.immediateMessage && !promptOverride) {
      const immediate: ContainerOutput = {
        status: 'success',
        result: prelude.immediateMessage,
        toolsUsed: [],
        toolExecutions: [],
        effectiveUserPrompt: latestUserPrompt(messagesForRequestWithSkillCache),
      };
      immediate.sideEffects = getPendingSideEffects();
      writeOutput(immediate);
      console.error('[approval] resolved user response without model run');
      continue;
    }

    let output = await processRequest(
      messagesForRequestWithSkillCache,
      apiKey,
      input.baseUrl,
      input.provider,
      input.isLocal,
      input.contextWindow,
      input.thinkingFormat,
      input.model,
      input.chatbotId,
      input.enableRag,
      requestHeaders,
      resolveTools(input),
      taskModels,
      input.contextGuard,
      input.channelId,
      input.skipContainerSystemPrompt === true,
      input.streamTextDeltas === true,
      input.maxTokens,
      promptOverride,
      input.ralphMaxIterations,
    );
    if (
      messagesForRequestWithSkillCache !== input.messages &&
      output.status === 'error' &&
      shouldRetryWithoutNativeMedia(output.error)
    ) {
      console.error(
        '[media] native media injection rejected by model; retrying without native media parts',
      );
      const retryMessages = promptOverride
        ? replaceLatestUserPrompt(input.messages, promptOverride)
        : input.messages;
      const retryMessagesWithSkillCache = injectSkillCacheHint(retryMessages);
      output = await processRequest(
        retryMessagesWithSkillCache,
        apiKey,
        input.baseUrl,
        input.provider,
        input.isLocal,
        input.contextWindow,
        input.thinkingFormat,
        input.model,
        input.chatbotId,
        input.enableRag,
        requestHeaders,
        resolveTools(input),
        taskModels,
        input.contextGuard,
        input.channelId,
        input.skipContainerSystemPrompt === true,
        input.streamTextDeltas === true,
        input.maxTokens,
        promptOverride,
        input.ralphMaxIterations,
      );
    }

    output.sideEffects = getPendingSideEffects();
    writeOutput(output);
    console.error(`[hybridclaw-agent] request complete: ${output.status}`);
  }
}

main().catch((err) => {
  console.error('Container agent fatal error:', err);
  void shutdownAgentProcess(1, 'fatal error', {
    status: 'error',
    result: null,
    toolsUsed: [],
    error: `Unhandled error: ${err instanceof Error ? err.message : String(err)}`,
  });
});
