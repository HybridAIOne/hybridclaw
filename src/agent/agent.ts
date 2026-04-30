import { DEFAULT_AGENT_ID } from '../agents/agent-types.js';
import { HYBRIDAI_MODEL } from '../config/config.js';
import { injectPdfContextMessages } from '../media/pdf-context.js';
import { withSpan } from '../observability/otel.js';
import { createConfidentialRuntimeContext } from '../security/confidential-runtime.js';
import type { ContainerOutput } from '../types/container.js';
import type {
  PendingApproval,
  ToolExecution,
  ToolProgressEvent,
} from '../types/execution.js';
import { getExecutor } from './executor.js';
import type { ExecutorRequest } from './executor-types.js';
import { mergeBlockedToolNames } from './tool-policy.js';

const TOOL_EXECUTION_REHYDRATE_FIELDS: ReadonlyArray<keyof ToolExecution> = [
  'arguments',
  'result',
  'blockedReason',
  'approvalIntent',
  'approvalReason',
];

const PENDING_APPROVAL_REHYDRATE_FIELDS: ReadonlyArray<keyof PendingApproval> =
  ['prompt', 'intent', 'reason'];

const TOOL_PROGRESS_REHYDRATE_FIELDS: ReadonlyArray<keyof ToolProgressEvent> = [
  'preview',
];

export async function runAgent(
  params: ExecutorRequest,
): Promise<ContainerOutput> {
  return withSpan(
    'hybridclaw.agent.run',
    {
      'hybridclaw.session_id': params.sessionId,
      'hybridclaw.agent_id': params.agentId || '',
      'hybridclaw.model': params.model || '',
    },
    async () => runAgentInner(params),
  );
}

async function runAgentInner(
  params: ExecutorRequest,
): Promise<ContainerOutput> {
  const sessionId = params.sessionId;
  const chatbotId = params.chatbotId;
  const model = params.model || HYBRIDAI_MODEL;
  const agentId = params.agentId || DEFAULT_AGENT_ID;
  const channelId = params.channelId || '';
  const media = params.media;
  const blockedTools = mergeBlockedToolNames({ explicit: params.blockedTools });
  const executor = getExecutor(params.executorModeOverride);
  const workspaceRoot =
    params.workspacePathOverride || executor.getWorkspacePath(agentId);
  const preparedMessages = await injectPdfContextMessages({
    sessionId,
    messages: params.messages,
    workspaceRoot,
    media,
  });
  const confidential = createConfidentialRuntimeContext();
  const dehydratedMessages = confidential.dehydrate(preparedMessages);
  const output = await executor.exec({
    ...params,
    sessionId,
    messages: dehydratedMessages,
    chatbotId,
    model,
    agentId,
    workspacePathOverride: params.workspacePathOverride,
    workspaceDisplayRootOverride: params.workspaceDisplayRootOverride,
    skipContainerSystemPrompt: params.skipContainerSystemPrompt,
    maxTokens: params.maxTokens,
    maxWallClockMs: params.maxWallClockMs,
    inactivityTimeoutMs: params.inactivityTimeoutMs,
    bashProxy: params.bashProxy,
    channelId,
    media,
    blockedTools,
    onTextDelta: confidential.wrapDelta(params.onTextDelta),
    onThinkingDelta: confidential.wrapDelta(params.onThinkingDelta),
    onToolProgress: confidential.wrapEvent(
      params.onToolProgress,
      TOOL_PROGRESS_REHYDRATE_FIELDS,
    ),
    onApprovalProgress: confidential.wrapEvent(
      params.onApprovalProgress,
      PENDING_APPROVAL_REHYDRATE_FIELDS,
    ),
  });
  if (!confidential.enabled) return output;
  const rehydratedToolExecutions = output.toolExecutions?.map(
    (execution) =>
      confidential.rehydrateFields(
        execution,
        TOOL_EXECUTION_REHYDRATE_FIELDS,
      ) ?? execution,
  );
  const rehydratedPendingApproval = confidential.rehydrateFields(
    output.pendingApproval,
    PENDING_APPROVAL_REHYDRATE_FIELDS,
  );
  return {
    ...output,
    result: output.result
      ? confidential.rehydrate(output.result)
      : output.result,
    error: output.error ? confidential.rehydrate(output.error) : output.error,
    effectiveUserPrompt: output.effectiveUserPrompt
      ? confidential.rehydrate(output.effectiveUserPrompt)
      : output.effectiveUserPrompt,
    toolExecutions: rehydratedToolExecutions ?? output.toolExecutions,
    pendingApproval: rehydratedPendingApproval ?? output.pendingApproval,
  };
}
