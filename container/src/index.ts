import { callHybridAI } from './hybridai-client.js';
import { waitForInput, writeOutput } from './ipc.js';
import { executeTool, TOOL_DEFINITIONS } from './tools.js';
import type { ChatMessage, ContainerInput, ContainerOutput, ToolExecution } from './types.js';

const MAX_ITERATIONS = 12;
const IDLE_TIMEOUT_MS = parseInt(process.env.CONTAINER_IDLE_TIMEOUT || '300000', 10); // 5 min

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
): Promise<ContainerOutput> {
  const history: ChatMessage[] = [...messages];
  const toolsUsed: string[] = [];
  const toolExecutions: ToolExecution[] = [];
  let iterations = 0;

  while (iterations < MAX_ITERATIONS) {
    iterations++;

    let response;
    try {
      response = await callHybridAI(baseUrl, apiKey, model, chatbotId, enableRag, history, TOOL_DEFINITIONS);
    } catch (err) {
      return { status: 'error', result: null, toolsUsed, toolExecutions, error: `API error: ${err instanceof Error ? err.message : String(err)}` };
    }

    const choice = response.choices[0];
    if (!choice) {
      return { status: 'error', result: null, toolsUsed, toolExecutions, error: 'No response from API' };
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
      return { status: 'success', result: choice.message.content, toolsUsed: [...new Set(toolsUsed)], toolExecutions };
    }

    for (const call of toolCalls) {
      const toolName = call.function.name;
      toolsUsed.push(toolName);
      console.error(`[tool] ${toolName}: ${call.function.arguments.slice(0, 100)}`);
      const toolStart = Date.now();
      const result = await executeTool(toolName, call.function.arguments);
      const toolDuration = Date.now() - toolStart;
      console.error(`[tool] ${toolName} result (${toolDuration}ms): ${result.slice(0, 100)}`);
      toolExecutions.push({
        name: toolName,
        arguments: call.function.arguments,
        result,
        durationMs: toolDuration,
      });
      history.push({ role: 'tool', content: result, tool_call_id: call.id });

      // Bail on fatal filesystem/system errors — retrying won't help
      if (/EROFS|EPERM|EACCES|read-only file system/i.test(result)) {
        return { status: 'error', result: null, toolsUsed, toolExecutions, error: result };
      }
    }
  }

  const lastAssistant = history.filter((m) => m.role === 'assistant').pop();
  return { status: 'success', result: lastAssistant?.content || 'Max tool iterations reached.', toolsUsed: [...new Set(toolsUsed)], toolExecutions };
}

/**
 * Main loop: read first request from stdin (with secrets), then poll IPC for follow-ups.
 */
async function main(): Promise<void> {
  console.error(`[hybridclaw-agent] started, idle timeout ${IDLE_TIMEOUT_MS}ms`);

  // First request arrives via stdin (contains apiKey — never written to disk)
  const stdinData = await readStdinLine();
  const firstInput: ContainerInput = JSON.parse(stdinData);
  storedApiKey = firstInput.apiKey;

  console.error(`[hybridclaw-agent] processing first request (${firstInput.messages.length} messages)`);

  const firstOutput = await processRequest(
    firstInput.messages,
    storedApiKey,
    firstInput.baseUrl,
    firstInput.model,
    firstInput.chatbotId,
    firstInput.enableRag,
  );

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

    const output = await processRequest(
      input.messages,
      apiKey,
      input.baseUrl,
      input.model,
      input.chatbotId,
      input.enableRag,
    );

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
