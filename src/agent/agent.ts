import { DEFAULT_AGENT_ID } from '../agents/agent-types.js';
import { HYBRIDAI_MODEL } from '../config/config.js';
import { injectPdfContextMessages } from '../media/pdf-context.js';
import { withSpan } from '../observability/otel.js';
import type { ContainerOutput } from '../types/container.js';
import { getExecutor } from './executor.js';
import type { ExecutorRequest } from './executor-types.js';
import { mergeBlockedToolNames } from './tool-policy.js';

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
  return executor.exec({
    ...params,
    sessionId,
    messages: preparedMessages,
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
  });
}
