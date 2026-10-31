/**
 * Tool hooks enforce active gateway-configured pattern guards before execution.
 * File-format validation remains independent of those configurable rules.
 * Unlike approval policy, these hooks never grant consent or promote trust.
 */
import { activeSafetyBlock } from './safety-rules.js';
import { parseToolArgsJsonOrThrow } from './tool-args.js';

type RuntimeEventName =
  | 'before_agent_start'
  | 'before_model_call'
  | 'after_model_call'
  | 'model_retry'
  | 'model_error'
  | 'pre_tool_use'
  | 'post_tool_use'
  | 'before_tool_call'
  | 'after_tool_call'
  | 'mcp_server_connected'
  | 'mcp_server_disconnected'
  | 'mcp_server_error'
  | 'mcp_tool_call'
  | 'turn_end';

interface RuntimeEventPayload {
  event: RuntimeEventName;
  [key: string]: unknown;
}

interface RuntimeExtension {
  name: string;
  onEvent?: (payload: RuntimeEventPayload) => void | Promise<void>;
  onBeforeToolCall?: (
    toolName: string,
    args: Record<string, unknown>,
  ) => string | null | Promise<string | null>;
  onAfterToolCall?: (
    toolName: string,
    args: Record<string, unknown>,
    result: string,
  ) => void | Promise<void>;
}

const BINARY_OFFICE_FILE_RE = /\.(docx|xlsx|pptx|pdf)$/i;

function getBlockedBinaryOfficeFileReason(
  toolName: string,
  args: Record<string, unknown>,
): string | null {
  if (toolName !== 'write' && toolName !== 'edit') return null;
  const targetPath = String(args.path || '').trim();
  if (!BINARY_OFFICE_FILE_RE.test(targetPath)) return null;
  return `Refusing to ${toolName} plain text into binary Office/PDF file \`${targetPath}\`. Generate the artifact with a real tool or script instead of the file ${toolName} tool.`;
}

const securityHookExtension: RuntimeExtension = {
  name: 'security-hook',
  onBeforeToolCall: (toolName, args) => {
    const binaryOfficeReason = getBlockedBinaryOfficeFileReason(toolName, args);
    if (binaryOfficeReason) return binaryOfficeReason;

    if (toolName === 'write' || toolName === 'edit') {
      const content =
        toolName === 'write'
          ? String(args.contents || '')
          : String(args.new || '');
      const blocked = activeSafetyBlock('file-content', content);
      if (blocked) return blocked;
    }

    if (toolName === 'bash') {
      const command = String(args.command || '');
      return activeSafetyBlock('bash', command);
    }

    return null;
  },
};

const runtimeExtensions: RuntimeExtension[] = [securityHookExtension];

export const INVALID_ARGS_MESSAGE = 'Invalid tool hook arguments.';

function describeError(error: unknown): string {
  if (error instanceof Error) return error.name;
  return typeof error;
}

function describeErrorCause(error: unknown): string {
  if (error instanceof Error && error.cause) return describeError(error.cause);
  return describeError(error);
}

function logExtensionFailure(
  extension: string,
  hook: string,
  error: unknown,
): void {
  console.error(
    `[hybridclaw-agent] runtime extension "${extension}" ${hook} failed (${describeError(error)})`,
  );
}

function logHookArgumentParseFailure(hook: string, error: unknown): void {
  console.error(
    `[hybridclaw-agent] ${hook} failed to parse tool hook arguments (${describeErrorCause(error)})`,
  );
}

function parseArgs(argsJson: string): Record<string, unknown> {
  return parseToolArgsJsonOrThrow(argsJson, INVALID_ARGS_MESSAGE);
}

export async function emitRuntimeEvent(
  payload: RuntimeEventPayload,
): Promise<void> {
  for (const ext of runtimeExtensions) {
    if (!ext.onEvent) continue;
    try {
      await ext.onEvent(payload);
    } catch (error) {
      logExtensionFailure(ext.name, 'onEvent hook', error);
      // Best effort: extension errors should not break request handling.
    }
  }
}

export async function runBeforeToolHooks(
  toolName: string,
  argsJson: string,
): Promise<string | null> {
  let args: Record<string, unknown>;
  try {
    args = parseArgs(argsJson);
  } catch (error) {
    logHookArgumentParseFailure('before-tool hook', error);
    await emitRuntimeEvent({
      event: 'before_tool_call',
      toolName,
      blocked: true,
      extension: 'runtime',
      reason: INVALID_ARGS_MESSAGE,
    });
    return INVALID_ARGS_MESSAGE;
  }

  for (const ext of runtimeExtensions) {
    if (!ext.onBeforeToolCall) continue;
    try {
      const blocked = await ext.onBeforeToolCall(toolName, args);
      if (blocked) {
        await emitRuntimeEvent({
          event: 'before_tool_call',
          toolName,
          blocked: true,
          extension: ext.name,
          reason: blocked,
        });
        return blocked;
      }
    } catch (error) {
      logExtensionFailure(ext.name, 'onBeforeToolCall hook', error);
      const reason = `Runtime extension "${ext.name}" failed while checking tool permissions.`;
      await emitRuntimeEvent({
        event: 'before_tool_call',
        toolName,
        blocked: true,
        extension: ext.name,
        reason,
      });
      return reason;
    }
  }
  await emitRuntimeEvent({
    event: 'before_tool_call',
    toolName,
    blocked: false,
  });
  return null;
}

export async function runAfterToolHooks(
  toolName: string,
  argsJson: string,
  result: string,
): Promise<void> {
  let args: Record<string, unknown>;
  try {
    args = parseArgs(argsJson);
  } catch (error) {
    logHookArgumentParseFailure('after-tool hook', error);
    await emitRuntimeEvent({
      event: 'after_tool_call',
      toolName,
      reason: INVALID_ARGS_MESSAGE,
    });
    return;
  }

  for (const ext of runtimeExtensions) {
    if (!ext.onAfterToolCall) continue;
    try {
      await ext.onAfterToolCall(toolName, args, result);
    } catch (error) {
      logExtensionFailure(ext.name, 'onAfterToolCall hook', error);
      // Best effort: after-tool extension errors should not mask tool results.
    }
  }
  await emitRuntimeEvent({ event: 'after_tool_call', toolName });
}
