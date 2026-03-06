import { emitRuntimeEvent, runAfterToolHooks, runBeforeToolHooks } from './extensions.js';
import { callHybridAI, HybridAIRequestError } from './hybridai-client.js';
import { emitStdioEvent, readStdinRequests, writeOutput } from './ipc.js';
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
      emitStdioEvent({ type: 'tool_start', name: toolName, args: call.function.arguments.slice(0, 100) });
      const toolStart = Date.now();
      const blockedReason = await runBeforeToolHooks(toolName, call.function.arguments);
      const result = blockedReason
        ? `Tool blocked by security hook: ${blockedReason}`
        : await executeTool(toolName, call.function.arguments);
      const toolDuration = Date.now() - toolStart;
      await runAfterToolHooks(toolName, call.function.arguments, result);
      console.error(`[tool] ${toolName} result (${toolDuration}ms): ${result.slice(0, 100)}`);
      emitStdioEvent({ type: 'tool_finish', name: toolName, durationMs: toolDuration, preview: result.slice(0, 100) });
      toolExecutions.push({
        name: toolName,
        arguments: call.function.arguments,
        result,
        durationMs: toolDuration,
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


function defaultEmitOutput(output: ContainerOutput): void {
  writeOutput(output);
}

async function processAndRespond(input: ContainerInput, emitFn: (output: ContainerOutput) => void): Promise<void> {
  const apiKey = input.apiKey || storedApiKey;

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
  emitFn(output);
  console.error(`[hybridclaw-agent] request complete: ${output.status}`);
}

async function main(): Promise<void> {
  console.error(`[hybridclaw-agent] started, idle timeout ${IDLE_TIMEOUT_MS}ms, ipc=stdio`);

  // All requests arrive as NDJSON lines on stdin. The first line carries the apiKey.
  let first = true;
  for await (const input of readStdinRequests()) {
    if (first) {
      storedApiKey = input.apiKey;
      first = false;
      console.error(`[hybridclaw-agent] processing first request (${input.messages.length} messages)`);
    } else {
      console.error(`[hybridclaw-agent] processing stdin request (${input.messages.length} messages)`);
    }
    await processAndRespond(input, defaultEmitOutput);
  }
  console.error('[hybridclaw-agent] stdin closed, exiting');
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
