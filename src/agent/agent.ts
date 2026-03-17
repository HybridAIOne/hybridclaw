import fs from 'node:fs';
import path from 'node:path';

import { DEFAULT_AGENT_ID } from '../agents/agent-types.js';
import { DATA_DIR, HYBRIDAI_MODEL } from '../config/config.js';
import { injectPdfContextMessages } from '../media/pdf-context.js';
import type {
  ChatMessage,
  ContainerOutput,
  MediaContextItem,
} from '../types.js';
import {
  type BootstrapContextMode,
  buildContextPrompt,
  loadBootstrapFiles,
} from '../workspace.js';
import { getExecutor } from './executor.js';
import type { ExecutorRequest } from './executor-types.js';

/** Write full prompt context to data/last_prompt.jsonl for debugging (Pi-Mono style). */
function dumpPrompt(
  sessionId: string,
  messages: ChatMessage[],
  model: string,
  chatbotId: string,
  media?: MediaContextItem[],
  allowedTools?: string[],
  blockedTools?: string[],
  bootstrapContextMode?: BootstrapContextMode,
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
      bootstrapContextMode,
    };
    const filePath = path.join(DATA_DIR, 'last_prompt.jsonl');
    fs.writeFileSync(filePath, `${JSON.stringify(entry)}\n`);
  } catch {
    /* best-effort */
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
  const blockedTools = params.blockedTools;
  const bootstrapContextMode = params.bootstrapContextMode;
  const workspaceRoot = getExecutor().getWorkspacePath(agentId);
  const bootstrapContextPrompt = bootstrapContextMode
    ? buildContextPrompt(
        loadBootstrapFiles(agentId, {
          mode: bootstrapContextMode,
        }),
      )
    : '';
  const messagesWithBootstrap =
    bootstrapContextPrompt.trim().length > 0
      ? [
          {
            role: 'system' as const,
            content: bootstrapContextPrompt,
          },
          ...params.messages,
        ]
      : params.messages;
  const preparedMessages = await injectPdfContextMessages({
    sessionId,
    messages: messagesWithBootstrap,
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
    bootstrapContextMode,
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
  });
}
