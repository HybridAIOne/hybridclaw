/**
 * Worker reply shapes are checked before gateway consumers see them.
 * File safety belongs to ipc.ts; this boundary rejects malformed payloads
 * without logging their content or granting authority to valid tool history.
 */
import { validateToolHistory } from '../../container/shared/tool-history.js';
import type { ContainerOutput } from '../types/container.js';
import { isRecord } from '../utils/type-guards.js';

type Check = (value: unknown) => boolean;
const string: Check = (value) => typeof value === 'string';
const number: Check = (value) =>
  typeof value === 'number' && Number.isFinite(value);
const boolean: Check = (value) => typeof value === 'boolean';
const nullable =
  (check: Check): Check =>
  (value) =>
    value === null || check(value);
const array =
  (check: Check): Check =>
  (value) =>
    Array.isArray(value) && value.every(check);
const shape =
  (
    required: Record<string, Check>,
    optional: Record<string, Check> = {},
  ): Check =>
  (value) =>
    isRecord(value) &&
    Object.entries(required).every(([key, check]) => check(value[key])) &&
    Object.entries(optional).every(
      ([key, check]) => value[key] === undefined || check(value[key]),
    );
const strings = array(string);
const oneOf =
  (...values: string[]): Check =>
  (value) =>
    typeof value === 'string' && values.includes(value);
const history: Check = (value) => {
  try {
    validateToolHistory(value);
    return true;
  } catch {
    return false;
  }
};
const task = shape({ prompt: string }, { label: string, model: string });
const delegation = shape(
  { action: (value) => value === 'delegate' },
  {
    mode: (value) =>
      value === 'single' || value === 'parallel' || value === 'chain',
    prompt: string,
    label: string,
    model: string,
    tasks: array(task),
    chain: array(task),
  },
);
const approval = shape(
  {
    approvalId: string,
    prompt: string,
    intent: string,
    reason: string,
    allowSession: boolean,
    allowAgent: boolean,
    allowAll: boolean,
    expiresAt: nullable(number),
  },
  {
    toolName: string,
    commandPreview: string,
    reviewArguments: string,
    escalationTarget: shape({ channel: string, recipient: string }),
  },
);
const tool = shape(
  { name: string, arguments: string, result: string, durationMs: number },
  {
    isError: boolean,
    blocked: boolean,
    writeIntent: boolean,
    blockedReason: string,
    toolCallId: string,
  },
);

// Exhaustive over the transport type: adding a reply field requires a boundary check.
const fields = {
  status: (value) => value === 'success' || value === 'error',
  result: nullable(string),
  toolsUsed: strings,
  error: string,
  errorCode: (value) => value === 'busy',
  effectiveUserPrompt: string,
  spilledToolCallIds: strings,
  steerNoteIds: strings,
  artifacts: array(shape({ path: string, filename: string, mimeType: string })),
  memoryCitations: array(
    shape({
      ref: string,
      memoryId: number,
      content: string,
      confidence: number,
    }),
  ),
  toolExecutions: array(tool),
  toolHistory: history,
  toolHistoryForReplay: history,
  pendingApproval: approval,
  tokenUsage: shape({
    modelCalls: number,
    apiUsageAvailable: boolean,
    apiPromptTokens: number,
    apiCompletionTokens: number,
    apiTotalTokens: number,
    apiCacheUsageAvailable: boolean,
    apiCacheReadTokens: number,
    apiCacheWriteTokens: number,
    estimatedPromptTokens: number,
    estimatedCompletionTokens: number,
    estimatedTotalTokens: number,
  }),
  outputPresentation: shape({
    segmentKind: oneOf('draft', 'final', 'tool_request', 'approval', 'status'),
    visible: boolean,
    displaySurface: oneOf('none', 'assistant_bubble', 'approval'),
  }),
  sideEffects: shape({}, { delegations: array(delegation) }),
  approvalReply: shape(
    {
      decision: oneOf(
        'approve',
        'deny',
        'revise',
        'unclear',
        'unrelated',
        'error',
      ),
      approvalId: nullable(string),
      scope: nullable(oneOf('once', 'session', 'agent', 'all')),
    },
    { model: string },
  ),
  recovery: shape(
    { kind: (value) => value === 'refused' || value === 'recovered' },
    {
      turnId: string,
      calls: array(
        shape({
          messageIndex: number,
          toolCallId: string,
          outcome: oneOf('result_recorded', 'outcome_unknown', 'not_executed'),
        }),
      ),
    },
  ),
} satisfies Record<keyof Required<ContainerOutput>, Check>;

export function isContainerOutput(value: unknown): value is ContainerOutput {
  if (
    !isRecord(value) ||
    !fields.status(value.status) ||
    !fields.result(value.result) ||
    !fields.toolsUsed(value.toolsUsed)
  )
    return false;
  return Object.entries(fields).every(
    ([key, check]) => value[key] === undefined || check(value[key]),
  );
}
