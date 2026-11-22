/**
 * Tool failures retain their model-visible output across implementation modules.
 * Unlike approval denials, this carries no permission or retry decision. The
 * audit code of a failure comes only from what its path reports (an HTTP
 * status, a JSON-RPC error, a deadline), never from parsing its message.
 */
import type { ToolErrorCode } from '@hybridclaw/contracts/tool-error-code';
import { ExecutionDeadlineError } from '@hybridclaw/shared/execution-deadline';
import { SseError } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

export class ToolExecutionFailure extends Error {
  readonly output: string;
  readonly errorCode: ToolErrorCode | undefined;

  constructor(output: string, errorCode?: ToolErrorCode) {
    super(output);
    this.name = 'ToolExecutionFailure';
    this.output = output;
    this.errorCode = errorCode;
  }
}

export function failTool(output: string, errorCode?: ToolErrorCode): never {
  throw new ToolExecutionFailure(output, errorCode);
}

// The HTTP mapping documented on google.rpc.Code, plus 412 and 502.
const HTTP_STATUS_CODES: Record<number, ToolErrorCode> = {
  400: 'INVALID_ARGUMENT',
  401: 'UNAUTHENTICATED',
  403: 'PERMISSION_DENIED',
  404: 'NOT_FOUND',
  409: 'ABORTED',
  412: 'FAILED_PRECONDITION',
  429: 'RESOURCE_EXHAUSTED',
  499: 'CANCELLED',
  500: 'INTERNAL',
  501: 'UNIMPLEMENTED',
  502: 'UNAVAILABLE',
  503: 'UNAVAILABLE',
  504: 'DEADLINE_EXCEEDED',
};

export function httpStatusErrorCode(status: unknown): ToolErrorCode {
  return (typeof status === 'number' && HTTP_STATUS_CODES[status]) || 'UNKNOWN';
}

const JSON_RPC_CODES: Record<number, ToolErrorCode> = {
  [ErrorCode.ConnectionClosed]: 'UNAVAILABLE',
  [ErrorCode.RequestTimeout]: 'DEADLINE_EXCEEDED',
  [ErrorCode.ParseError]: 'INVALID_ARGUMENT',
  [ErrorCode.InvalidRequest]: 'INVALID_ARGUMENT',
  [ErrorCode.MethodNotFound]: 'UNIMPLEMENTED',
  [ErrorCode.InvalidParams]: 'INVALID_ARGUMENT',
  [ErrorCode.InternalError]: 'INTERNAL',
};

/** The code of a thrown tool failure; `undefined` when its path reports none. */
export function thrownToolErrorCode(err: unknown): ToolErrorCode | undefined {
  if (err instanceof ToolExecutionFailure) return err.errorCode;
  if (err instanceof ExecutionDeadlineError) return 'DEADLINE_EXCEEDED';
  if (err instanceof McpError) return JSON_RPC_CODES[err.code] ?? 'UNKNOWN';
  if (err instanceof StreamableHTTPError || err instanceof SseError) {
    return httpStatusErrorCode(err.code);
  }
  // A wrapper that adds recovery hints keeps the code of what it wraps.
  return err instanceof Error ? thrownToolErrorCode(err.cause) : undefined;
}
