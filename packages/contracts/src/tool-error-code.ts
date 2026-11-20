/**
 * Why a tool call failed, as a canonical google.rpc.Code name. A code names
 * the kind of failure and never quotes its message, which can carry user
 * data, so audit readers may show it where they may not show the result.
 * NOT the model-visible error text, and NOT a retry decision.
 */
export const TOOL_ERROR_CODES = [
  'CANCELLED',
  'UNKNOWN',
  'INVALID_ARGUMENT',
  'DEADLINE_EXCEEDED',
  'NOT_FOUND',
  'ALREADY_EXISTS',
  'PERMISSION_DENIED',
  'RESOURCE_EXHAUSTED',
  'FAILED_PRECONDITION',
  'ABORTED',
  'OUT_OF_RANGE',
  'UNIMPLEMENTED',
  'INTERNAL',
  'UNAVAILABLE',
  'DATA_LOSS',
  'UNAUTHENTICATED',
] as const;

export type ToolErrorCode = (typeof TOOL_ERROR_CODES)[number];
