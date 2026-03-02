import { emitRuntimeEvent, runAfterToolHooks, runBeforeToolHooks } from './extensions.js';
import { callHybridAI, HybridAIRequestError } from './hybridai-client.js';
import { waitForInput, writeOutput } from './ipc.js';
import { executeTool, getPendingSideEffects, resetSideEffects, setScheduledTasks, setSessionContext, TOOL_DEFINITIONS } from './tools.js';
import type { ChatMessage, ContainerInput, ContainerOutput, ToolDefinition, ToolExecution } from './types.js';

const MAX_ITERATIONS = 20;
const IDLE_TIMEOUT_MS = parseInt(process.env.CONTAINER_IDLE_TIMEOUT || '300000', 10); // 5 min
const RETRY_ENABLED = process.env.HYBRIDCLAW_RETRY_ENABLED !== 'false';
const RETRY_MAX_ATTEMPTS = Math.max(1, parseInt(process.env.HYBRIDCLAW_RETRY_MAX_ATTEMPTS || '3', 10));
const RETRY_BASE_DELAY_MS = Math.max(100, parseInt(process.env.HYBRIDCLAW_RETRY_BASE_DELAY_MS || '2000', 10));
const RETRY_MAX_DELAY_MS = Math.max(RETRY_BASE_DELAY_MS, parseInt(process.env.HYBRIDCLAW_RETRY_MAX_DELAY_MS || '8000', 10));

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

async function callHybridAIWithRetry(params: {
  baseUrl: string;
  apiKey: string;
  model: string;
  chatbotId: string;
  enableRag: boolean;
  history: ChatMessage[];
  tools: ToolDefinition[];
}): Promise<Awaited<ReturnType<typeof callHybridAI>>> {
  const { baseUrl, apiKey, model, chatbotId, enableRag, history, tools } = params;
  let attempt = 0;
  let delayMs = RETRY_BASE_DELAY_MS;

  while (true) {
    attempt += 1;
    await emitRuntimeEvent({ event: 'before_model_call', attempt });
    try {
      const response = await callHybridAI(baseUrl, apiKey, model, chatbotId, enableRag, history, tools);
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
  let iterations = 0;

  while (iterations < MAX_ITERATIONS) {
    iterations++;

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
      });
    } catch (err) {
      const failed: ContainerOutput = {
        status: 'error',
        result: null,
        toolsUsed,
        toolExecutions,
        error: `API error: ${err instanceof Error ? err.message : String(err)}`,
      };
      await emitRuntimeEvent({ event: 'turn_end', status: failed.status, toolsUsed });
      return failed;
    }

    const choice = response.choices[0];
    if (!choice) {
      const failed: ContainerOutput = {
        status: 'error',
        result: null,
        toolsUsed,
        toolExecutions,
        error: 'No response from API',
      };
      await emitRuntimeEvent({ event: 'turn_end', status: failed.status, toolsUsed });
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

    const toolCalls = choice.message.tool_calls || [];
    if (toolCalls.length === 0) {
      const completed: ContainerOutput = {
        status: 'success',
        result: choice.message.content,
        toolsUsed: [...new Set(toolsUsed)],
        toolExecutions,
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
      history.push({ role: 'tool', content: result, tool_call_id: call.id });

      // Bail on fatal filesystem/system errors — retrying won't help
      if (/EROFS|EPERM|EACCES|read-only file system/i.test(result)) {
        const failed: ContainerOutput = {
          status: 'error',
          result: null,
          toolsUsed,
          toolExecutions,
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
    result: lastAssistant?.content || 'Max tool iterations reached.',
    toolsUsed: [...new Set(toolsUsed)],
    toolExecutions,
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
