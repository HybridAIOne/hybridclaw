import fs from 'node:fs';
import path from 'node:path';

import { DEFAULT_AGENT_ID } from '../agents/agent-types.js';
import { DATA_DIR, HYBRIDAI_MODEL } from '../config/config.js';
import { logger } from '../logger.js';
import { injectPdfContextMessages } from '../media/pdf-context.js';
import type { ChatMessage } from '../types/api.js';
import type { ContainerOutput, MediaContextItem } from '../types/container.js';
import { getExecutor } from './executor.js';
import type { ExecutorRequest } from './executor-types.js';
import { mergeBlockedToolNames } from './tool-policy.js';

/** Write full prompt context to data/last_prompt.jsonl for debugging (Pi-Mono style). */
function dumpPrompt(
  sessionId: string,
  messages: ChatMessage[],
  model: string,
  chatbotId: string,
  media?: MediaContextItem[],
  allowedTools?: string[],
  blockedTools?: string[],
): void {
  try {
    const entry = {
      ts: new Date().toISOString(),
      sessionId,
      model,
      chatbotId,
      messages,
      media: Array.isArray(media) ? media : [],
      allowedTools: Array.isArray(allowedTools) ? allowedTools : undefined,
      blockedTools: Array.isArray(blockedTools) ? blockedTools : undefined,
    };
    const filePath = path.join(DATA_DIR, 'last_prompt.jsonl');
    fs.writeFileSync(filePath, `${JSON.stringify(entry)}\n`);
  } catch (err) {
    logger.debug({ sessionId, err }, 'Failed to dump prompt context');
  }
}

export async function runAgent(
  params: ExecutorRequest,
): Promise<ContainerOutput> {
  const sessionId = params.sessionId;
  const chatbotId = params.chatbotId;
  const model = params.model || HYBRIDAI_MODEL;
  const agentId = params.agentId || DEFAULT_AGENT_ID;
  const channelId = params.channelId || '';
  const media = params.media;
  const allowedTools = params.allowedTools;
  const blockedTools = mergeBlockedToolNames({ explicit: params.blockedTools });
  const workspaceRoot = getExecutor().getWorkspacePath(agentId);
  const preparedMessages = await injectPdfContextMessages({
    sessionId,
    messages: params.messages,
    workspaceRoot,
    media,
  });
  dumpPrompt(
    sessionId,
    preparedMessages,
    model,
    chatbotId,
    media,
    allowedTools,
    blockedTools,
  );
  return getExecutor().exec({
    ...params,
    sessionId,
    messages: preparedMessages,
    chatbotId,
    model,
    agentId,
    channelId,
    media,
    blockedTools,
  });
}
