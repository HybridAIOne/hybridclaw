import path from 'path';

import { emitRuntimeEvent, runAfterToolHooks, runBeforeToolHooks } from './extensions.js';
import { callHybridAI, callHybridAIStream, HybridAIRequestError } from './hybridai-client.js';
import { waitForInput, writeOutput } from './ipc.js';
import {
  accumulateApiUsage,
  createTokenUsageStats,
  estimateMessageTokens,
  estimateTextTokens,
  finalizeTokenUsage,
} from './token-usage.js';
import {
  executeTool,
  getPendingSideEffects,
  resetSideEffects,
  setGatewayContext,
  setModelContext,
  setScheduledTasks,
  setSessionContext,
  TOOL_DEFINITIONS,
} from './tools.js';
import type { ArtifactMetadata, ChatMessage, ContainerInput, ContainerOutput, ToolDefinition, ToolExecution } from './types.js';

const MAX_ITERATIONS = 20;
const IDLE_TIMEOUT_MS = parseInt(process.env.CONTAINER_IDLE_TIMEOUT || '300000', 10); // 5 min
const RETRY_ENABLED = process.env.HYBRIDCLAW_RETRY_ENABLED !== 'false';
const RETRY_MAX_ATTEMPTS = Math.max(1, parseInt(process.env.HYBRIDCLAW_RETRY_MAX_ATTEMPTS || '3', 10));
const RETRY_BASE_DELAY_MS = Math.max(100, parseInt(process.env.HYBRIDCLAW_RETRY_BASE_DELAY_MS || '2000', 10));
const RETRY_MAX_DELAY_MS = Math.max(RETRY_BASE_DELAY_MS, parseInt(process.env.HYBRIDCLAW_RETRY_MAX_DELAY_MS || '8000', 10));
const RAW_RALPH_MAX_EXTRA_ITERATIONS = Number.parseInt(process.env.HYBRIDCLAW_RALPH_MAX_ITERATIONS || '0', 10);
const RALPH_MAX_EXTRA_ITERATIONS = Number.isFinite(RAW_RALPH_MAX_EXTRA_ITERATIONS)
  ? (RAW_RALPH_MAX_EXTRA_ITERATIONS === -1
    ? -1
    : Math.max(0, Math.min(64, RAW_RALPH_MAX_EXTRA_ITERATIONS)))
  : 0;
const RALPH_ENABLED = RALPH_MAX_EXTRA_ITERATIONS !== 0;
const WORKSPACE_ROOT = '/workspace';
const ARTIFACT_MIME_TYPES: Record<string, string> = {
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

/** API key received once via stdin, held in memory for the container lifetime. */
let storedApiKey = '';

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

function isRetryableError(err: unknown): boolean {
  if (err instanceof HybridAIRequestError) {
    return err.status === 429 || (err.status >= 500 && err.status <= 504);
  }
  const message = err instanceof Error ? err.message : String(err);
  return /fetch failed|network|socket|timeout|timed out|ECONNRESET|ECONNREFUSED|EAI_AGAIN/i.test(message);
}

function inferToolError(result: string, blockedReason: string | null): boolean {
  if (blockedReason) return true;
  return /\b(error|failed|denied|forbidden|timed out|timeout|exception|invalid)\b/i.test(result);
}

function latestUserPrompt(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== 'user') continue;
    const text = String(message.content || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    return text.slice(0, 1_200);
  }
  return 'Continue the task';
}

function parseRalphChoice(content: string | null): 'CONTINUE' | 'STOP' | null {
  if (!content) return null;
  const re = /<choice>\s*([^<]*)\s*<\/choice>/gi;
  let match: RegExpExecArray | null = null;
  let lastChoice: string | null = null;
  while (true) {
    match = re.exec(content);
    if (!match) break;
    lastChoice = (match[1] || '').trim().toUpperCase();
  }
  if (lastChoice === 'CONTINUE' || lastChoice === 'STOP') return lastChoice;
  return null;
}

function stripRalphChoiceTags(content: string | null): string | null {
  if (content == null) return content;
  const stripped = content
    .replace(/<choice>\s*[^<]*\s*<\/choice>/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return stripped || content;
}

function buildRalphPrompt(taskPrompt: string, missingChoice: boolean): string {
  const punctuatedPrompt = /[.!?]$/.test(taskPrompt) ? taskPrompt : `${taskPrompt}.`;
  const lines = [
    `${punctuatedPrompt} (You are running in an automated loop where the same prompt is fed repeatedly. Only choose STOP when the task is fully complete. Including it will stop further iterations. If you are not 100% sure, choose CONTINUE.)`,
    '',
    'Available branches:',
    '- CONTINUE',
    '- STOP',
    '',
    'Reply with a choice using <choice>...</choice>.',
  ];
  if (missingChoice) {
    lines.push('');
    lines.push('Your last response did not include a valid choice. Include exactly one: CONTINUE or STOP.');
  }
  return lines.join('\n');
}

function resolveMaxModelTurns(): number {
  if (!RALPH_ENABLED) return MAX_ITERATIONS;
  if (RALPH_MAX_EXTRA_ITERATIONS < 0) return Number.MAX_SAFE_INTEGER;
  return Math.max(MAX_ITERATIONS, RALPH_MAX_EXTRA_ITERATIONS + 1);
}

function inferMimeType(filePath: string): string {
  const ext = path.posix.extname(filePath).toLowerCase();
  return ARTIFACT_MIME_TYPES[ext] || 'application/octet-stream';
}

function normalizeArtifactPath(rawPath: unknown): string | null {
  const value = String(rawPath || '').trim();
  if (!value) return null;
  const normalized = value.replace(/\\/g, '/');
  if (path.posix.isAbsolute(normalized)) {
    const cleanAbs = path.posix.normalize(normalized);
    if (cleanAbs === WORKSPACE_ROOT || cleanAbs.startsWith(`${WORKSPACE_ROOT}/`)) {
      return cleanAbs;
    }
    return null;
  }

  const clean = path.posix.normalize(normalized);
  if (clean === '..' || clean.startsWith('../')) return null;
  return path.posix.join(WORKSPACE_ROOT, clean);
}

function extractToolArtifacts(toolName: string, result: string): ArtifactMetadata[] {
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

  const addArtifact = (rawPath: unknown, rawFilename?: unknown, rawMimeType?: unknown): void => {
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

async function callHybridAIWithRetry(params: {
  baseUrl: string;
  apiKey: string;
  model: string;
  chatbotId: string;
  enableRag: boolean;
  history: ChatMessage[];
  tools: ToolDefinition[];
  onTextDelta?: (delta: string) => void;
}): Promise<Awaited<ReturnType<typeof callHybridAI>>> {
  const {
    baseUrl,
    apiKey,
    model,
    chatbotId,
    enableRag,
    history,
    tools,
    onTextDelta,
  } = params;
  let attempt = 0;
  let delayMs = RETRY_BASE_DELAY_MS;

  while (true) {
    attempt += 1;
    await emitRuntimeEvent({ event: 'before_model_call', attempt });
    try {
      let response;
      if (onTextDelta) {
        try {
          response = await callHybridAIStream(
            baseUrl,
            apiKey,
            model,
            chatbotId,
            enableRag,
            history,
            tools,
            onTextDelta,
          );
        } catch (streamErr) {
          const fallbackEligible =
            streamErr instanceof HybridAIRequestError
            && streamErr.status >= 400
            && streamErr.status < 500
            && streamErr.status !== 429;
          if (!fallbackEligible) throw streamErr;
          response = await callHybridAI(baseUrl, apiKey, model, chatbotId, enableRag, history, tools);
        }
      } else {
        response = await callHybridAI(baseUrl, apiKey, model, chatbotId, enableRag, history, tools);
      }
      await emitRuntimeEvent({ event: 'after_model_call', attempt, toolCallCount: response.choices[0]?.message?.tool_calls?.length || 0 });
      return response;
    } catch (err) {
      const retryable = RETRY_ENABLED && isRetryableError(err) && attempt < RETRY_MAX_ATTEMPTS;
      await emitRuntimeEvent({
        event: retryable ? 'model_retry' : 'model_error',
        attempt,
        retryable,
        error: err instanceof Error ? err.message : String(err),
      });
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
  model: string,
  chatbotId: string,
  enableRag: boolean,
  tools: ToolDefinition[],
): Promise<ContainerOutput> {
  await emitRuntimeEvent({ event: 'before_agent_start', messageCount: messages.length });
  const history: ChatMessage[] = [...messages];
  const toolsUsed: string[] = [];
  const toolExecutions: ToolExecution[] = [];
  const artifacts: ArtifactMetadata[] = [];
  const artifactPaths = new Set<string>();
  const tokenUsage = createTokenUsageStats();
  const ralphSeedPrompt = RALPH_ENABLED ? latestUserPrompt(messages) : '';
  const maxModelTurns = resolveMaxModelTurns();
  let ralphExtraIterations = 0;
  let iterations = 0;

  while (iterations < maxModelTurns) {
    iterations++;
    tokenUsage.modelCalls += 1;
    tokenUsage.estimatedPromptTokens += estimateMessageTokens(history);

    let response;
    try {
      response = await callHybridAIWithRetry({
        baseUrl,
        apiKey,
        model,
        chatbotId,
        enableRag,
        history,
        tools,
        onTextDelta: emitStreamDelta,
      });
    } catch (err) {
      const failed: ContainerOutput = {
        status: 'error',
        result: null,
        toolsUsed,
        ...(artifacts.length > 0 ? { artifacts } : {}),
        toolExecutions,
        tokenUsage: finalizeTokenUsage(tokenUsage),
        error: `API error: ${err instanceof Error ? err.message : String(err)}`,
      };
      await emitRuntimeEvent({ event: 'turn_end', status: failed.status, toolsUsed });
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
      await emitRuntimeEvent({ event: 'turn_end', status: failed.status, toolsUsed });
      return failed;
    }

    tokenUsage.estimatedCompletionTokens += estimateTextTokens(choice.message.content);
    if (choice.message.tool_calls?.length) {
      tokenUsage.estimatedCompletionTokens += estimateTextTokens(JSON.stringify(choice.message.tool_calls));
    }

    const assistantMessage: ChatMessage = {
      role: 'assistant',
      content: choice.message.content,
    };

    if (choice.message.tool_calls && choice.message.tool_calls.length > 0) {
      assistantMessage.tool_calls = choice.message.tool_calls;
    }

    history.push(assistantMessage);

    const toolCalls = choice.message.tool_calls || [];
    if (toolCalls.length === 0) {
      if (RALPH_ENABLED) {
        const branchChoice = parseRalphChoice(choice.message.content);
        if (branchChoice === 'STOP') {
          const completed: ContainerOutput = {
            status: 'success',
            result: stripRalphChoiceTags(choice.message.content),
            toolsUsed: [...new Set(toolsUsed)],
            ...(artifacts.length > 0 ? { artifacts } : {}),
            toolExecutions,
            tokenUsage: finalizeTokenUsage(tokenUsage),
          };
          await emitRuntimeEvent({ event: 'turn_end', status: completed.status, toolsUsed: completed.toolsUsed });
          return completed;
        }

        const canContinue = RALPH_MAX_EXTRA_ITERATIONS < 0 || ralphExtraIterations < RALPH_MAX_EXTRA_ITERATIONS;
        if (canContinue) {
          ralphExtraIterations += 1;
          history.push({
            role: 'user',
            content: buildRalphPrompt(ralphSeedPrompt, branchChoice == null),
          });
          console.error(
            `[ralph] continue ${ralphExtraIterations}`
            + (RALPH_MAX_EXTRA_ITERATIONS < 0 ? '' : `/${RALPH_MAX_EXTRA_ITERATIONS}`),
          );
          continue;
        }
      }

      const completed: ContainerOutput = {
        status: 'success',
        result: stripRalphChoiceTags(choice.message.content),
        toolsUsed: [...new Set(toolsUsed)],
        ...(artifacts.length > 0 ? { artifacts } : {}),
        toolExecutions,
        tokenUsage: finalizeTokenUsage(tokenUsage),
      };
      await emitRuntimeEvent({ event: 'turn_end', status: completed.status, toolsUsed: completed.toolsUsed });
      return completed;
    }

    for (const call of toolCalls) {
      const toolName = call.function.name;
      toolsUsed.push(toolName);
      console.error(`[tool] ${toolName}: ${call.function.arguments.slice(0, 100)}`);
      const toolStart = Date.now();
      const blockedReason = await runBeforeToolHooks(toolName, call.function.arguments);
      const result = blockedReason
        ? `Tool blocked by security hook: ${blockedReason}`
        : await executeTool(toolName, call.function.arguments);
      const toolDuration = Date.now() - toolStart;
      const isError = inferToolError(result, blockedReason);
      await runAfterToolHooks(toolName, call.function.arguments, result);
      console.error(`[tool] ${toolName} result (${toolDuration}ms): ${result.slice(0, 100)}`);
      toolExecutions.push({
        name: toolName,
        arguments: call.function.arguments,
        result,
        durationMs: toolDuration,
        isError,
        blocked: Boolean(blockedReason),
        blockedReason: blockedReason || undefined,
      });
      for (const artifact of extractToolArtifacts(toolName, result)) {
        if (artifactPaths.has(artifact.path)) continue;
        artifactPaths.add(artifact.path);
        artifacts.push(artifact);
      }
      history.push({ role: 'tool', content: result, tool_call_id: call.id });

      // Bail on fatal filesystem/system errors — retrying won't help
      if (/EROFS|EPERM|EACCES|read-only file system/i.test(result)) {
        const failed: ContainerOutput = {
          status: 'error',
          result: null,
          toolsUsed,
          ...(artifacts.length > 0 ? { artifacts } : {}),
          toolExecutions,
          tokenUsage: finalizeTokenUsage(tokenUsage),
          error: result,
        };
        await emitRuntimeEvent({ event: 'turn_end', status: failed.status, toolsUsed });
        return failed;
      }
    }
  }

  const lastAssistant = history.filter((m) => m.role === 'assistant').pop();
  const completed: ContainerOutput = {
    status: 'success',
    result: stripRalphChoiceTags(lastAssistant?.content || null) || 'Max tool iterations reached.',
    toolsUsed: [...new Set(toolsUsed)],
    ...(artifacts.length > 0 ? { artifacts } : {}),
    toolExecutions,
    tokenUsage: finalizeTokenUsage(tokenUsage),
  };
  await emitRuntimeEvent({ event: 'turn_end', status: completed.status, toolsUsed: completed.toolsUsed });
  return completed;
}

/**
 * Main loop: read first request from stdin (with secrets), then poll IPC for follow-ups.
 */
function resolveTools(input: ContainerInput): ToolDefinition[] {
  const tools = input.allowedTools
    ? TOOL_DEFINITIONS.filter((t) => input.allowedTools!.includes(t.function.name))
    : [...TOOL_DEFINITIONS];
  // Sort alphabetically for deterministic system-prompt ordering (KV cache stability)
  tools.sort((a, b) => a.function.name.localeCompare(b.function.name));
  return tools;
}

async function main(): Promise<void> {
  console.error(`[hybridclaw-agent] started, idle timeout ${IDLE_TIMEOUT_MS}ms`);

  // First request arrives via stdin (contains apiKey — never written to disk)
  const stdinData = await readStdinLine();
  const firstInput: ContainerInput = JSON.parse(stdinData);
  storedApiKey = firstInput.apiKey;

  console.error(`[hybridclaw-agent] processing first request (${firstInput.messages.length} messages)`);

  resetSideEffects();
  setScheduledTasks(firstInput.scheduledTasks);
  setSessionContext(firstInput.sessionId);
  setGatewayContext(firstInput.gatewayBaseUrl, firstInput.gatewayApiToken, firstInput.channelId);
  setModelContext(firstInput.baseUrl, storedApiKey, firstInput.model, firstInput.chatbotId);

  const firstOutput = await processRequest(
    firstInput.messages,
    storedApiKey,
    firstInput.baseUrl,
    firstInput.model,
    firstInput.chatbotId,
    firstInput.enableRag,
    resolveTools(firstInput),
  );

  firstOutput.sideEffects = getPendingSideEffects();
  writeOutput(firstOutput);
  console.error(`[hybridclaw-agent] first request complete: ${firstOutput.status}`);

  // Subsequent requests come via IPC file polling
  while (true) {
    const input = await waitForInput(IDLE_TIMEOUT_MS);

    if (!input) {
      console.error('[hybridclaw-agent] idle timeout, exiting');
      process.exit(0);
    }

    // Use stored apiKey — IPC file no longer contains it
    const apiKey = input.apiKey || storedApiKey;

    console.error(`[hybridclaw-agent] processing request (${input.messages.length} messages)`);

    resetSideEffects();
    setScheduledTasks(input.scheduledTasks);
    setSessionContext(input.sessionId);
    setGatewayContext(input.gatewayBaseUrl, input.gatewayApiToken, input.channelId);
    setModelContext(input.baseUrl, apiKey, input.model, input.chatbotId);

    const output = await processRequest(
      input.messages,
      apiKey,
      input.baseUrl,
      input.model,
      input.chatbotId,
      input.enableRag,
      resolveTools(input),
    );

    output.sideEffects = getPendingSideEffects();
    writeOutput(output);
    console.error(`[hybridclaw-agent] request complete: ${output.status}`);
  }
}

main().catch((err) => {
  console.error('Container agent fatal error:', err);
  writeOutput({
    status: 'error',
    result: null,
    toolsUsed: [],
    error: `Unhandled error: ${err instanceof Error ? err.message : String(err)}`,
  });
  process.exit(1);
});
